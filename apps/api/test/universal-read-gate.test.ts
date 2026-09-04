/**
 * The DATA-PLANE universal-read gate for POST /memories/search
 * (authz/guards.ts → allowUniversalRead).
 *
 * Invariant (docs/internal/users_roles.md): the data plane is own ∪ mounted for
 * EVERYONE. `universal:true` (all-teams fan-out via searchMemoriesMerged) is
 * honored ONLY for admin+ callers. A plain member's `universal:true` MUST be
 * ignored so they fall back to own ∪ mounted — mounts are how a member is granted
 * cross-team reads. The dashboard's all-teams view goes through /dashboard/memories
 * (decideDashboard), not this route, so this gate does not affect it.
 *
 * Pure-function unit (mirrors merge.test.ts / usage.test.ts bearerOk) — no
 * app.inject, no DB, no Qdrant. allowUniversalRead is the whole gate;
 * searchMemoriesMerged only fans out to all teams when it receives universal:true,
 * so proving the gate never returns true for a member proves the member stays
 * own ∪ mounted on the data plane.
 */
import { describe, it, expect } from 'vitest'
import { allowUniversalRead } from '../src/authz/guards.ts'

describe('allowUniversalRead — data-plane /memories/search gate', () => {
  it('IGNORES a member’s universal:true (→ own ∪ mounted)', () => {
    // The bug being fixed: a plain member passing universal:true must NOT get an
    // all-teams fan-out. The gate returns false → merge stays own ∪ mounted.
    expect(allowUniversalRead('none', true)).toBe(false)
  })

  it('HONORS universal:true for a team-admin', () => {
    expect(allowUniversalRead('admin', true)).toBe(true)
  })

  it('HONORS universal:true for a superuser', () => {
    expect(allowUniversalRead('superuser', true)).toBe(true)
  })

  it('returns false when universal is not requested, regardless of role', () => {
    // Default/omitted (undefined) and explicit false both → own ∪ mounted for all.
    expect(allowUniversalRead('none', undefined)).toBe(false)
    expect(allowUniversalRead('admin', undefined)).toBe(false)
    expect(allowUniversalRead('superuser', undefined)).toBe(false)
    expect(allowUniversalRead('none', false)).toBe(false)
    expect(allowUniversalRead('admin', false)).toBe(false)
    expect(allowUniversalRead('superuser', false)).toBe(false)
  })
})
