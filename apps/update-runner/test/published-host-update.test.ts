import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hostCommand } from '../../onboard/server/host.ts'

const roots: string[] = []
const repo = fileURLToPath(new URL('../../../', import.meta.url)).replaceAll('\\', '/')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function bash(script: string, args: string[] = [], cwd = repo): string {
  const command = hostCommand('bash', ['--noprofile', '--norc', '-c', script, '_', ...args])
  return execFileSync(command.command, command.args, { cwd, encoding: 'utf8', env: command.env, windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function functionSource(name: string): Promise<string> {
  const source = (await readFile(join(repo, 'deploy/scripts/update.sh'), 'utf8')).replaceAll('\r\n', '\n')
  const start = source.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`Missing ${name}`)
  const next = source.slice(start + 1).search(/\n[a-z_]+\(\) \{/u)
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next)
}

async function fixture() {
  const fixtureParent = join(repo, '.local')
  await mkdir(fixtureParent, { recursive: true })
  const root = (await mkdtemp(join(fixtureParent, 'pm-published-host-'))).replaceAll('\\', '/')
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${root}`, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--quiet')
  git('remote', 'add', 'origin', root)
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'layers/update-ops/update-flow'), { recursive: true })
  await writeFile(join(root, 'layers/update-ops/update-flow/public-source.json'), JSON.stringify({ releaseLine: 'public-v1' }))
  await writeFile(join(root, '.gitignore'), '.local/\n.env.persistent-memory\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.1.0', persistentMemoryReleaseLine: 'public-v1' }))
  git('add', '.')
  git('commit', '--quiet', '-m', 'Published version')
  const commit = git('rev-parse', 'HEAD')
  git('tag', 'v1.1.0')
  await writeFile(join(root, 'unpublished.txt'), 'Not part of published release')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Newer unpublished same-version code')
  const head = git('rev-parse', 'HEAD')
  // This fake is only the discovery boundary; the actual shell worktree/tag
  // validation runs unchanged against a disposable local Git origin.
  await writeFile(join(root, 'scripts/github-releases.mjs'), `console.log(${JSON.stringify(JSON.stringify({ version: '1.1.0', tag: 'v1.1.0', commit, url: 'https://example.test/release' }))})\n`)
  await writeFile(join(root, '.env.persistent-memory'), 'FIXTURE_ONLY=preserved\n')
  return { root, git, commit, head }
}

describe('published host updater', () => {
  it.each([
    { args: [], expected: 'published||' },
    { args: ['--release', '1.1.0'], expected: 'published||1.1.0' },
    { args: ['--dev'], expected: 'branch|dev|' },
    { args: ['--master'], expected: 'branch|master|' },
    { args: ['--branch', 'feature/test'], expected: 'branch|feature/test|' },
    { args: ['--release', '1.0.0', '--branch', 'dev'], expected: 'branch|dev|1.0.0' },
  ])('resolves option mode for $args', async ({ args, expected }) => {
    const source = await Promise.all(['validate_update_branch_name', 'validate_update_release', 'parse_update_args'].map(functionSource))
    const result = bash(`set -eu\nUPDATE_BRANCH_OVERRIDE=''; UPDATE_RELEASE_OVERRIDE=''; UPDATE_RELEASE_BRANCH_EXPLICIT=0; UPDATE_RELEASE_BRANCH_SHORTCUT=0; UPDATE_SOURCE_MODE=published; UPDATE_SHOW_HELP=0\nfail() { echo "$1" >&2; }\n${source.join('\n')}\nparse_update_args "$@"\nprintf '%s|%s|%s' "$UPDATE_SOURCE_MODE" "$UPDATE_BRANCH_OVERRIDE" "$UPDATE_RELEASE_OVERRIDE"`, args)
    expect(result).toBe(expected)
  })

  it('deploys the tag worktree without moving the calling checkout to unpublished code', async () => {
    const { root, git, commit, head } = await fixture()
    const source = await Promise.all(['release_at_commit', 'resolve_release_worktree'].map(functionSource))
    const output = bash(`set -eu\nsource "$1/deploy/scripts/lib/host-platform.sh"\nsource "$1/deploy/scripts/lib/public-update-source.sh"\nSCRIPT_REPO_ROOT="$2"; SOURCE_REPO_ROOT="$2"; SOURCE_ENV_RUNTIME="$2/.env.persistent-memory"; UPDATE_SOURCE_MODE=published; UPDATE_RELEASE_OVERRIDE=''; UPDATE_BRANCH_OVERRIDE=''; VERSIONED_WORKTREE=0\nfail() { echo "$1" >&2; }; ok() { :; }\nconfigure_update_context() { REPO_ROOT="$1"; cd "$1"; }\nreload_compose_from_env() { :; }\ncurrent_package_version() { node -p 'require("./package.json").version'; }\n${source.join('\n')}\nresolve_release_worktree\nprintf '\\nRESULT=%s' "$REPO_ROOT"`, [repo, root], root)
    const worktree = output.match(/RESULT=(.*)$/u)![1]!
    expect(git('-C', worktree, 'rev-parse', 'HEAD')).toBe(commit)
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(join(worktree, '.env.persistent-memory'), 'utf8')).toBe('FIXTURE_ONLY=preserved\n')
    expect(resolve(worktree).startsWith(resolve(root, '.local/release-worktrees'))).toBe(true)
  })

  it('rejects a moved remote tag even when the expected commit remains cached', async () => {
    const { root, git, commit } = await fixture()
    git('tag', '-f', 'v1.1.0', 'HEAD')
    expect(() => bash('source "$1/deploy/scripts/lib/public-update-source.sh"; pm_git_fetch_published_tag "$2" v1.1.0 "$3"', [repo, root, commit], root)).toThrow()
  })

  it('does not expose Git helper stdout or stderr when fetching a published tag fails', async () => {
    const { root, git, commit } = await fixture()
    const sentinel = 'FIXTURE_ONLY_GIT_HELPER_SECRET'
    await writeFile(join(root, 'fake-ssh.sh'), `#!/bin/sh\necho invoked > "${root}/ssh-invoked"\necho ${sentinel}\necho ${sentinel} >&2\nexit 1\n`)
    git('config', 'core.sshCommand', `sh "${root}/fake-ssh.sh"`)
    git('remote', 'set-url', 'origin', 'ssh://fixture.invalid/repository')
    let failure: { message?: string; stdout?: string; stderr?: string } | undefined
    try {
      bash('source "$1/deploy/scripts/lib/public-update-source.sh"; pm_git_fetch_published_tag "$2" v1.1.0 "$3"', [repo, root, commit], root)
    } catch (error) {
      failure = error as typeof failure
    }
    expect(failure).toBeDefined()
    expect((await readFile(join(root, 'ssh-invoked'), 'utf8')).trim()).toBe('invoked')
    expect(failure?.stderr).toContain('Published release Git fetch failed.')
    expect(`${failure?.message}\n${failure?.stdout}\n${failure?.stderr}`).not.toContain(sentinel)
  })
})
