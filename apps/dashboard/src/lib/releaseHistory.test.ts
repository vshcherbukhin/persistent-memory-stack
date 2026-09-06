import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseReleaseHistoryForUi } from './releaseHistory'
import { APP_VERSION } from './version'

describe('release history UI parsing', () => {
  it('ships one coherent first-public release card in both published history copies', () => {
    const rootHistory = readFileSync(new URL('../../../../release-history.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const dashboardHistory = readFileSync(new URL('../../public/release-history.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const rootPackage = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string; persistentMemoryReleaseLine: string }
    expect(dashboardHistory).toBe(rootHistory)
    expect(APP_VERSION).toBe('1.0.0')
    expect(rootPackage.version).toBe(APP_VERSION)
    expect(rootPackage.persistentMemoryReleaseLine).toBe('public-v1')
    expect(rootHistory).toContain('<!-- persistent-memory-release-line: public-v1 -->')
    const cards = parseReleaseHistoryForUi(dashboardHistory)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ version: APP_VERSION, latest: true })
    expect(cards[0]!.services.length).toBeGreaterThan(0)
    expect(cards[0]!.services.every((service) => service.version === APP_VERSION)).toBe(true)
    expect(cards[0]!.body).not.toContain('persistent-memory-release-line')
    expect(cards[0]!.body).not.toContain('<!--')
  })

  it('renders the first public release without requiring older history', () => {
    const releases = parseReleaseHistoryForUi('# Release History\n\n## 1.0.0 - 2026-09-06\n\n| Service | Version | Change |\n| --- | --- | --- |\n| dashboard | 1.0.0 | First public release. |\n\n- Personal memory on macOS and Windows.\n')
    expect(releases).toEqual([expect.objectContaining({ version: '1.0.0', latest: true, services: [{ service: 'dashboard', version: '1.0.0', change: 'First public release.' }], body: '- Personal memory on macOS and Windows.' })])
  })

  it('marks only the newest release as latest and preserves service versions', () => {
    const releases = parseReleaseHistoryForUi(`# Release History

## 3.5.0 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| update/ops | 0.2.0 | Added one-click update. |

- Added dashboard updates.

## 3.4.6 - 2026-07-03

- Fixed env handling.
`)
    expect(releases).toHaveLength(2)
    expect(releases[0]).toMatchObject({ version: '3.5.0', latest: true })
    expect(releases[0]?.services).toEqual([
      { service: 'update/ops', version: '0.2.0', change: 'Added one-click update.' },
    ])
    expect(releases[0]?.body).toBe('- Added dashboard updates.')
    expect(releases[1]).toMatchObject({ version: '3.4.6', latest: false })
  })
})
