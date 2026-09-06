import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalInstallationRoot, legacyUpdateInvocation } from '../../update-coordinator/src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const gitBash = process.env.PM_GIT_BASH ?? 'C:/Program Files/Git/bin/bash.exe'
const bash = process.platform === 'win32' ? gitBash : 'bash'

function runBash(script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): string {
  const childEnv = { ...env }
  if (process.platform === 'win32') {
    const pathKey = Object.keys(childEnv).find((key) => key.toLowerCase() === 'path')
    const nativePath = pathKey ? childEnv[pathKey] ?? '' : ''
    if (pathKey) delete childEnv[pathKey]
    const gitRoot = win32.resolve(win32.dirname(bash), /[\\/]usr[\\/]bin[\\/]bash\.exe$/iu.test(bash) ? '../..' : '..')
    childEnv.PATH = `${win32.join(gitRoot, 'bin')};${win32.join(gitRoot, 'usr/bin')};${nativePath}`
  }
  return execFileSync(bash, ['--noprofile', '--norc', '-c', script, '_', ...args], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: childEnv,
  }).trim()
}

describe('Windows host lifecycle boundaries', () => {
  it('maps Windows release worktrees to the original coordinator installation root', () => {
    expect(canonicalInstallationRoot('C:\\Users\\Example Name\\repo\\.local\\release-worktrees\\release-a', 'win32'))
      .toBe('C:\\Users\\Example Name\\repo')
    expect(canonicalInstallationRoot('/Users/example/repo/.local/release-worktrees/release-a', 'darwin'))
      .toBe('/Users/example/repo')
  })

  it('accepts the usr/bin layout of Git for Windows with its actual cygpath location', () => {
    const pinnedBash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
    const files = new Set([pinnedBash, 'C:\\Program Files\\Git\\usr\\bin\\cygpath.exe'])
    expect(legacyUpdateInvocation('C:\\Memory Repo\\deploy\\scripts\\update.sh', [], { PM_GIT_BASH: pinnedBash }, 'win32', (path) => files.has(path)).command)
      .toBe(pinnedBash)
  })

  it('uses the pinned Git Bash and preserves Windows host and Linux container arguments', () => {
    const pinnedBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    const invocation = legacyUpdateInvocation('C:\\Memory Repo\\deploy\\scripts\\update.sh', ['--branch', 'dev'], {
      PM_GIT_BASH: pinnedBash,
    }, 'win32', () => true)
    expect(invocation.command).toBe(pinnedBash)
    expect(invocation.args).toEqual(['--noprofile', '--norc', 'C:/Memory Repo/deploy/scripts/update.sh', '--branch', 'dev'])
    expect(invocation.env).toMatchObject({ MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' })
  })

  it('rejects WSL Bash and preserves the macOS/Linux command', () => {
    expect(() => legacyUpdateInvocation('update.sh', [], {}, 'win32')).toThrow('Git for Windows')
    expect(() => legacyUpdateInvocation('update.sh', [], { PM_GIT_BASH: 'C:\\Windows\\System32\\bash.exe' }, 'win32',
      (path) => path === 'C:\\Windows\\System32\\bash.exe')).toThrow('Git for Windows')
    const env = { PATH: '/usr/bin' }
    expect(legacyUpdateInvocation('/repo/update.sh', ['--help'], env, 'darwin'))
      .toEqual({ command: 'bash', args: ['/repo/update.sh', '--help'], env })
  })

  it('preserves drive-letter handoff paths instead of prefixing the repository', () => {
    const output = runBash('source deploy/scripts/lib/update-handoff-state.sh; pm_normalize_handoff_state_dir "$1" "$2"', [
      'C:/Memory Repo', 'D:\\Memory State\\handoff',
    ])
    expect(output).toBe('D:/Memory State/handoff')
  })

  it.runIf(process.platform === 'win32' && existsSync(gitBash))('passes a Git Bash path with spaces to native Node without rewriting container paths', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'pm windows shell '))
    const file = join(fixture, 'fixture.json')
    try {
      await writeFile(file, '{"fixture":true}\n')
      const output = runBash('source deploy/scripts/lib/host-platform.sh; host=$(pm_host_path "$1"); node -e \'const fs=require("node:fs"); console.log(JSON.stringify({host:process.argv[1],exists:fs.existsSync(process.argv[1]),args:process.argv.slice(2)}))\' "$host" /snapshot /var/run/docker.sock', [
        file.replace(/\\/gu, '/'),
      ])
      expect(JSON.parse(output)).toEqual({ host: file.replace(/\\/gu, '/'), exists: true, args: ['/snapshot', '/var/run/docker.sock'] })
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32' && existsSync(gitBash))('cleans only a matching owned artifact under a Windows fixture home', async () => {
    const { createHash } = await import('node:crypto')
    const fixture = await mkdtemp(join(tmpdir(), 'pm windows ownership '))
    const home = join(fixture, 'home')
    const artifact = join(home, '.codex', 'rules', 'persistent-memory.md')
    const manifest = join(home, '.persistent-memory', 'installer-ownership.json')
    try {
      await mkdir(win32.dirname(artifact), { recursive: true })
      await mkdir(win32.dirname(manifest), { recursive: true })
      const content = '# Fixture rule\n'
      await writeFile(artifact, content)
      await writeFile(manifest, JSON.stringify({ version: 1, artifacts: [{
        path: artifact, artifactType: 'memory-rule', scope: 'global', digest: createHash('sha256').update(content).digest('hex'),
      }] }))
      const result = runBash('bash deploy/scripts/uninstall.sh --agent-cleanup-only', [], { ...process.env, HOME: home })
      expect(result).toContain('Removed installer-owned agent artifact')
      expect(existsSync(artifact)).toBe(false)
      expect(existsSync(manifest)).toBe(false)
      const { readdir } = await import('node:fs/promises')
      const backup = (await readdir(win32.dirname(artifact))).find((name) => name.endsWith('.bak'))
      expect(backup).toBeTruthy()
      expect(await readFile(join(win32.dirname(artifact), backup!), 'utf8')).toBe(content)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
