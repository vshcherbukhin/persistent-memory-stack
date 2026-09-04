import { describe, expect, it } from 'vitest'
import { compareSemver, detectMcpRestartRequired, parseReleaseHistory } from '../src/release.ts'

const HISTORY = `# Release History

## 3.5.0 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| update/ops | 0.2.0 | Added snapshot-safe updates. |
| dashboard | 3.5.0 | Added update popup. |
| MCP | 0.1.1 | Launcher metadata changed. |

- Added one-click updates. [mcp-restart]

## 3.4.6 - 2026-07-03

- Fixed env-file usage.
`

describe('release history parsing', () => {
  it('extracts the latest product release and per-service versions', () => {
    const parsed = parseReleaseHistory(HISTORY)
    expect(parsed[0]).toMatchObject({
      version: '3.5.0',
      date: '2026-07-03',
      latest: true,
      mcpRestartRequired: true,
    })
    expect(parsed[0]?.services).toEqual([
      { service: 'update/ops', version: '0.2.0', change: 'Added snapshot-safe updates.' },
      { service: 'dashboard', version: '3.5.0', change: 'Added update popup.' },
      { service: 'MCP', version: '0.1.1', change: 'Launcher metadata changed.' },
    ])
    expect(parsed[0]?.body).toBe('- Added one-click updates. [mcp-restart]')
    expect(parsed[1]).toMatchObject({ version: '3.4.6', latest: false })
  })

  it('compares three-part semver values numerically', () => {
    expect(compareSemver('3.10.0', '3.5.9')).toBeGreaterThan(0)
    expect(compareSemver('3.5.0', '3.5.0')).toBe(0)
    expect(compareSemver('3.4.9', '3.5.0')).toBeLessThan(0)
  })

  it('flags MCP restart when MCP or agent-facing paths changed', () => {
    expect(detectMcpRestartRequired(['apps/mcp/src/index.ts'])).toBe(true)
    expect(detectMcpRestartRequired(['mcp/src/index.ts'])).toBe(true)
    expect(detectMcpRestartRequired(['apps/onboard/server/register.ts'])).toBe(true)
    expect(detectMcpRestartRequired(['onboard/server/register.ts'])).toBe(true)
    expect(detectMcpRestartRequired(['apps/dashboard/src/components/AppHeader.tsx'])).toBe(false)
  })
})
