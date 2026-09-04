/**
 * Unit matrix for the pure authz decisions (no Fastify, no DB).
 * Proves the control ≠ data invariant at the decision layer.
 */
import { describe, it, expect } from 'vitest'
import { decideAdmin, decideSuperuser, decideTeamMember } from '../src/authz/guards.ts'

describe('decideTeamMember — data-plane membership gate', () => {
  it('allows a team member', () => {
    expect(decideTeamMember({ isTeamMember: true, teamId: 'team-a' }).ok).toBe(true)
  })
  it('denies a team-less caller (e.g. a global super-admin via the MCP)', () => {
    const d = decideTeamMember({ isTeamMember: false, teamId: null })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error.code).toBe('no_team')
  })
})

describe('decideAdmin — control-plane gate', () => {
  it('allows admin and superuser', () => {
    expect(decideAdmin('admin').ok).toBe(true)
    expect(decideAdmin('superuser').ok).toBe(true)
  })
  it('denies none', () => {
    const d = decideAdmin('none')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error.code).toBe('admin_required')
  })
})

describe('decideSuperuser — assign-admin-level escalation gate', () => {
  it('allows only superuser', () => {
    expect(decideSuperuser('superuser').ok).toBe(true)
  })
  it('denies admin (no privilege escalation)', () => {
    const d = decideSuperuser('admin')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error.code).toBe('superuser_required')
  })
  it('denies none', () => {
    expect(decideSuperuser('none').ok).toBe(false)
  })
})
