import { describe, expect, it } from 'vitest'
import { originGuardReason } from '../../../layers/onboarding/src/server/guard.ts'
import { buildSteps, hostRewriteUrl } from '../../../layers/onboarding/src/server/steps.ts'

describe('onboarding layer helpers', () => {
  it('exposes loopback guard decisions', () => {
    expect(originGuardReason('GET', '127.0.0.1:4319', undefined, 4319)).toBeNull()
    expect(originGuardReason('POST', '127.0.0.1:4319', 'http://evil.example.com', 4319)).toBe('bad_origin')
  })

  it('exposes install-flow planning helpers', () => {
    expect(hostRewriteUrl('postgresql://pmuser:pw@persistent-memory-postgres:5432/pm')).toContain('localhost:5433')
    expect(buildSteps({ flow: 'full', env: { DATABASE_MIGRATE_URL: 'postgresql://pmuser:pw@persistent-memory-postgres:5432/pm' } }).at(-1)?.id).toBe('write-rule')
  })
})
