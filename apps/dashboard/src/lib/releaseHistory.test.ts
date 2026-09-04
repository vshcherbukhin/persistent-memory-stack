import { describe, expect, it } from 'vitest'
import { parseReleaseHistoryForUi } from './releaseHistory'

describe('release history UI parsing', () => {
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
