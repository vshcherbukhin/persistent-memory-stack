import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

const layerCases = [
  ['core', 'Core'],
  ['dashboard', 'Dashboard'],
  ['docs-system', 'Docs System'],
  ['evidence-files', 'Evidence Files'],
  ['graph', 'Graph'],
  ['mcp-runtime', 'MCP Runtime'],
  ['memory-vector', 'Memory Vector'],
  ['onboarding', 'Onboarding'],
  ['security-dlp', 'Security DLP'],
  ['update-ops', 'Update Ops'],
] as const

describe('layer boundaries', () => {
  it.each(layerCases)('keeps the %s layer skeleton in place', (layer, title) => {
    const dir = `${root}/layers/${layer}`
    const readmePath = `${dir}/README.md`

    expect(existsSync(dir), `${layer} layer directory should exist`).toBe(true)
    expect(existsSync(readmePath), `${layer} layer README should exist`).toBe(true)

    const readme = readFileSync(readmePath, 'utf8')
    expect(readme.startsWith(`# ${title}`), `${layer} layer README title should match`).toBe(true)
    expect(readme, `${layer} layer README should point to its verification path`).toContain(
      `test/layers/${layer}/`,
    )
  })

  it('keeps the future dashboard-admin rename out of the layer tree', () => {
    expect(existsSync(`${root}/layers/dashboard-admin`)).toBe(false)
  })

  it('does not track generated Python bytecode', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter((path) => path.endsWith('.pyc') || path.endsWith('.pyo') || path.endsWith('.pyd') || path.includes('/__pycache__/'))

    expect(tracked).toEqual([])
  })

  it('keeps root Docker build contexts from sending local secrets or runtime artifacts', () => {
    const dockerignore = readFileSync(`${root}/.dockerignore`, 'utf8')

    expect(dockerignore).toContain('.local/')
    expect(dockerignore).toContain('.env.*')
    expect(dockerignore).toContain('!.env.persistent-memory.example')
    expect(dockerignore).toContain('.env.persistent-memory')
  })

  it('keeps deploy helper references on the deploy/scripts and deploy/compose paths', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .filter((path) => path !== 'test/layers/boundary.test.ts')
      // This compatibility test intentionally asserts the historical paths.
      .filter((path) => path !== 'apps/update-runner/test/legacy-4.0.24-update-bridge.test.ts')
      .filter((path) => !path.endsWith('release-history.md'))
      .filter((path) => !path.startsWith('.local/'))
      .filter((path) => !path.startsWith('.codex/rules/') && !path.startsWith('.claude/rules/'))
    const stalePatterns = [
      /(?<!deploy\/)scripts\/dev-redeploy\.sh/,
      /(?<!deploy\/)scripts\/install-server-client-managed\.sh/,
      /(?<!deploy\/)scripts\/install-server-server-managed\.sh/,
      /(?<!deploy\/)scripts\/apply-rls\.sh/,
      /(?<!deploy\/)scripts\/verify-install\.sh/,
      /(?<!deploy\/)scripts\/onboard\.sh/,
      /(?<!deploy\/)scripts\/update\.sh/,
      /(?<!deploy\/)scripts\/uninstall\.sh/,
      /docker compose --env-file/,
    ]
    const offenders: string[] = []

    for (const path of tracked) {
      const fullPath = `${root}/${path}`
      // `prisma` is an intentionally tracked compatibility symlink to the
      // schema directory. This guard examines file contents only.
      if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) continue
      const content = readFileSync(fullPath, 'utf8')
      if (stalePatterns.some((pattern) => pattern.test(content))) {
        offenders.push(path)
      }
    }

    expect(offenders).toEqual([])
  })
})
