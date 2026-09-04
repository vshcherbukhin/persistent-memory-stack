/**
 * Unit matrix for decideDataPlane — the "Memory MCP security guard" rules
 * (docs/internal/users_roles.md). Pure: no Fastify, no DB.
 *
 * Data plane = /memories/* (the MCP, and a user's own dashboard ops). Rules:
 *   • team-less caller → rejected for EVERY action (no_team).
 *   • search → allowed for any team member (universal read).
 *   • create → allowed for any team member (author + team stamped server-side).
 *   • update/delete → CURRENT-TEAM ONLY for everyone (even super-admins; cross
 *     team is dashboard-only). Within the team: admin/super-admin may touch ANY
 *     author; a plain member only their OWN-created rows.
 */
import { describe, it, expect } from 'vitest'
import { decideDataPlane, type DecisionIdentity } from '../src/authz/guards.ts'

const TEAM_A = 'team-a-uuid'
const TEAM_B = 'team-b-uuid'
const USER = 'user-uuid'
const OTHER = 'other-user-uuid'

function superGlobal(): DecisionIdentity {
  return { userId: USER, teamId: null, adminLevel: 'superuser', isTeamMember: false, isTeamAdmin: false, isGlobalSuperuser: true }
}
function superTeam(teamId = TEAM_A): DecisionIdentity {
  return { userId: USER, teamId, adminLevel: 'superuser', isTeamMember: true, isTeamAdmin: false, isGlobalSuperuser: true }
}
function adminTeam(teamId = TEAM_A): DecisionIdentity {
  return { userId: USER, teamId, adminLevel: 'admin', isTeamMember: true, isTeamAdmin: true, isGlobalSuperuser: false }
}
function member(teamId = TEAM_A, userId = USER): DecisionIdentity {
  return { userId, teamId, adminLevel: 'none', isTeamMember: true, isTeamAdmin: false, isGlobalSuperuser: false }
}

function denyCode(d: ReturnType<typeof decideDataPlane>): string | null {
  return d.ok ? null : d.error.code
}

describe('decideDataPlane — team-less callers are always rejected', () => {
  it('rejects create / search / update for a global super-admin (no team)', () => {
    expect(denyCode(decideDataPlane({ identity: superGlobal(), action: 'create' }))).toBe('no_team')
    expect(denyCode(decideDataPlane({ identity: superGlobal(), action: 'search' }))).toBe('no_team')
    expect(
      denyCode(decideDataPlane({ identity: superGlobal(), action: 'update', target: { teamId: TEAM_B, createdById: OTHER } })),
    ).toBe('no_team')
  })
})

describe('decideDataPlane — search/create allowed for any team member', () => {
  it('allows search for member, admin, team-super-admin (universal read)', () => {
    expect(decideDataPlane({ identity: member(), action: 'search' }).ok).toBe(true)
    expect(decideDataPlane({ identity: adminTeam(), action: 'search' }).ok).toBe(true)
    expect(decideDataPlane({ identity: superTeam(), action: 'search' }).ok).toBe(true)
  })
  it('allows create for member, admin, team-super-admin (current team)', () => {
    expect(decideDataPlane({ identity: member(), action: 'create' }).ok).toBe(true)
    expect(decideDataPlane({ identity: adminTeam(), action: 'create' }).ok).toBe(true)
    expect(decideDataPlane({ identity: superTeam(), action: 'create' }).ok).toBe(true)
  })
})

describe('decideDataPlane — update/delete are current-team only for everyone', () => {
  it('team super-admin: any author in own team OK; other team denied', () => {
    expect(decideDataPlane({ identity: superTeam(TEAM_A), action: 'update', target: { teamId: TEAM_A, createdById: OTHER } }).ok).toBe(true)
    expect(denyCode(decideDataPlane({ identity: superTeam(TEAM_A), action: 'update', target: { teamId: TEAM_B, createdById: OTHER } }))).toBe('cross_team_denied')
    expect(denyCode(decideDataPlane({ identity: superTeam(TEAM_A), action: 'delete', target: { teamId: TEAM_B, createdById: OTHER } }))).toBe('cross_team_denied')
  })
  it('team admin: any author in own team OK; other team denied', () => {
    expect(decideDataPlane({ identity: adminTeam(TEAM_A), action: 'update', target: { teamId: TEAM_A, createdById: OTHER } }).ok).toBe(true)
    expect(denyCode(decideDataPlane({ identity: adminTeam(TEAM_A), action: 'update', target: { teamId: TEAM_B, createdById: OTHER } }))).toBe('cross_team_denied')
  })
  it('member: only own-created in own team', () => {
    expect(decideDataPlane({ identity: member(TEAM_A, USER), action: 'update', target: { teamId: TEAM_A, createdById: USER } }).ok).toBe(true)
    expect(decideDataPlane({ identity: member(TEAM_A, USER), action: 'delete', target: { teamId: TEAM_A, createdById: USER } }).ok).toBe(true)
    expect(denyCode(decideDataPlane({ identity: member(TEAM_A, USER), action: 'update', target: { teamId: TEAM_A, createdById: OTHER } }))).toBe('not_owner')
    expect(denyCode(decideDataPlane({ identity: member(TEAM_A, USER), action: 'update', target: { teamId: TEAM_A, createdById: null } }))).toBe('not_owner')
    expect(denyCode(decideDataPlane({ identity: member(TEAM_A, USER), action: 'delete', target: { teamId: TEAM_B, createdById: USER } }))).toBe('cross_team_denied')
  })
  it('update/delete without a target is rejected', () => {
    expect(denyCode(decideDataPlane({ identity: member(), action: 'update' }))).toBe('target_required')
    expect(denyCode(decideDataPlane({ identity: adminTeam(), action: 'delete' }))).toBe('target_required')
  })
})
