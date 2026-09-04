import { describe, expect, it } from 'vitest'
import { parseLogEntries } from '../../../layers/dashboard/src/lib/logFormat.ts'
import { assessPasswordStrength } from '../../../layers/dashboard/src/lib/passwordStrength.ts'
import { parseReleaseHistoryForUi } from '../../../layers/dashboard/src/lib/releaseHistory.ts'

describe('dashboard layer helpers', () => {
  it('exposes pure dashboard helpers from the layer', () => {
    expect(parseLogEntries('2026-07-09T00:00:00Z api started')).toHaveLength(1)
    expect(assessPasswordStrength('long-enough-password').score).toBeGreaterThan(0)
    expect(parseReleaseHistoryForUi('## 1.2.3 - 2026-07-09\n\nChanges')).toMatchObject([
      { version: '1.2.3', latest: true },
    ])
  })
})
