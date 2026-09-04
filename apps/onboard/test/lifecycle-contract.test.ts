/**
 * R2 lifecycle contracts. These stay deliberately close to the user-visible
 * completion and uninstall boundaries until the production cleanup helper exists.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const appSource = () => readFileSync(join(root, 'apps/onboard/web/src/App.tsx'), 'utf8')
const uninstallSource = () => readFileSync(join(root, 'deploy/scripts/uninstall.sh'), 'utf8')

function component(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`)
  const next = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

describe('onboarding completion contract', () => {
  it('tells a passwordless local install that the dashboard opens directly to Personal Overview', () => {
    const done = component(appSource(), 'Done')

    expect(done).toContain('passwordConfigured')
    expect(done).toContain('opens directly to Personal Overview')
    expect(done).not.toContain('userPassword')
  })

  it('tells a password-configured local install that Go to dashboard opens local login first', () => {
    const done = component(appSource(), 'Done')

    expect(done).toContain('passwordConfigured')
    expect(done).toContain('Go to dashboard opens the local login screen first')
    expect(done).toMatch(/passwordConfigured\s*\?/)
  })
})

describe('uninstall ownership-safety contract', () => {
  it('records only installer-owned artifact metadata in a private manifest', () => {
    const script = uninstallSource()

    expect(script).toContain('ownership manifest')
    expect(script).toMatch(/chmod\s+600/)
    expect(script).toContain('digest')
    expect(script).toContain('artifact type')
    expect(script).toContain('scope')
    expect(script).not.toMatch(/manifest.*token/i)
    expect(script).not.toMatch(/manifest.*password/i)
  })

  it('removes only unchanged persistent-memory registrations and rules, backing up rewritten files', () => {
    const script = uninstallSource()

    expect(script).toContain('persistent-memory')
    expect(script).toContain('preserved because it was modified')
    expect(script).toContain('timestamped backup')
    expect(script).toMatch(/chmod\s+600/)
    expect(script).toContain('unrelated MCP entries')
    expect(script).toContain('unrelated TOML tables')
    expect(script).toContain('unrelated Markdown sections')
  })

  it('uses bounded legacy detection and clearly reports when no ownership manifest is available', () => {
    const script = uninstallSource()

    expect(script).toContain('No ownership manifest found')
    expect(script).toContain('legacy install')
    expect(script).toContain('could not be proven installer-owned')
  })

  it('stops before Compose volume removal when agent cleanup fails unless stack-only was explicitly selected', () => {
    const script = uninstallSource()
    const cleanup = script.indexOf('cleanup_installer_owned_agent_artifacts')
    const stackOnly = script.indexOf('stack-only removal')
    const composeDown = script.indexOf('down --remove-orphans --volumes --rmi all')

    expect(cleanup).toBeGreaterThanOrEqual(0)
    expect(stackOnly).toBeGreaterThanOrEqual(0)
    expect(composeDown).toBeGreaterThan(cleanup)
    expect(script.slice(cleanup, composeDown)).toContain('return 1')
  })
})
