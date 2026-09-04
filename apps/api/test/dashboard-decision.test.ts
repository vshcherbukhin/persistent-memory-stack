/**
 * Unit matrix for decideDashboard — the elevated /dashboard/memories/* rules
 * (docs/internal/users_roles.md "Dashboard"). Pure: no Fastify, no DB.
 *
 * Dashboard plane rules:
 *   • search/read → any control-plane principal (admin or super-admin), ANY team.
 *   • super-admin → full CRUD on ANY memory of ANY team (team-less or team-bound).
 *   • admin → CRUD ANY memory of OWN team only; other teams read-only.
 *   • plain member → not allowed here (admin_required).
 */
import { describe, it, expect } from 'vitest'
import { decideDashboard, type DecisionIdentity } from '../src/authz/guards.ts'

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
function member(teamId = TEAM_A): DecisionIdentity {
  return { userId: USER, teamId, adminLevel: 'none', isTeamMember: true, isTeamAdmin: false, isGlobalSuperuser: false }
}

function denyCode(d: ReturnType<typeof decideDashboard>): string | null {
  return d.ok ? null : d.error.code
}

describe('decideDashboard — search/read requires admin+', () => {
  it('allows super-admin and admin to search any team', () => {
    expect(decideDashboard({ identity: superGlobal(), action: 'search' }).ok).toBe(true)
    expect(decideDashboard({ identity: adminTeam(), action: 'search' }).ok).toBe(true)
  })
  it('denies a plain member', () => {
    expect(denyCode(decideDashboard({ identity: member(), action: 'search' }))).toBe('admin_required')
    expect(denyCode(decideDashboard({ identity: member(), action: 'update', target: { teamId: TEAM_A, createdById: USER } }))).toBe('admin_required')
  })
})

describe('decideDashboard — super-admin: any memory of any team', () => {
  it('global super-admin updates/deletes/creates across teams', () => {
    expect(decideDashboard({ identity: superGlobal(), action: 'update', target: { teamId: TEAM_B, createdById: OTHER } }).ok).toBe(true)
    expect(decideDashboard({ identity: superGlobal(), action: 'delete', target: { teamId: TEAM_A, createdById: OTHER } }).ok).toBe(true)
    expect(decideDashboard({ identity: superGlobal(), action: 'create' }).ok).toBe(true)
  })
  it('team-bound super-admin still crosses teams on the dashboard', () => {
    expect(decideDashboard({ identity: superTeam(TEAM_A), action: 'delete', target: { teamId: TEAM_B, createdById: OTHER } }).ok).toBe(true)
  })
})

describe('decideDashboard — admin: own team only, other teams read-only', () => {
  it('admin updates/deletes any author in own team', () => {
    expect(decideDashboard({ identity: adminTeam(TEAM_A), action: 'update', target: { teamId: TEAM_A, createdById: OTHER } }).ok).toBe(true)
    expect(decideDashboard({ identity: adminTeam(TEAM_A), action: 'delete', target: { teamId: TEAM_A, createdById: OTHER } }).ok).toBe(true)
  })
  it('admin is denied write to another team (read-only there)', () => {
    expect(denyCode(decideDashboard({ identity: adminTeam(TEAM_A), action: 'update', target: { teamId: TEAM_B, createdById: OTHER } }))).toBe('cross_team_read_only')
    expect(denyCode(decideDashboard({ identity: adminTeam(TEAM_A), action: 'delete', target: { teamId: TEAM_B, createdById: OTHER } }))).toBe('cross_team_read_only')
  })
  it('admin without a target is rejected (target_required)', () => {
    expect(denyCode(decideDashboard({ identity: adminTeam(), action: 'update' }))).toBe('target_required')
  })
})

describe('decideDashboard — create is own-team only for a team-admin', () => {
  it('admin is denied create into another team (read-only there)', () => {
    expect(denyCode(decideDashboard({ identity: adminTeam(TEAM_A), action: 'create', target: { teamId: TEAM_B, createdById: null } }))).toBe('cross_team_read_only')
  })
  it('admin may create into own team (explicit own-team target)', () => {
    expect(decideDashboard({ identity: adminTeam(TEAM_A), action: 'create', target: { teamId: TEAM_A, createdById: null } }).ok).toBe(true)
  })
  it('admin may create with no target (defaults to own team upstream)', () => {
    expect(decideDashboard({ identity: adminTeam(TEAM_A), action: 'create' }).ok).toBe(true)
  })
  it('super-admin still creates across teams', () => {
    expect(decideDashboard({ identity: superGlobal(), action: 'create', target: { teamId: TEAM_B, createdById: null } }).ok).toBe(true)
    expect(decideDashboard({ identity: superTeam(TEAM_A), action: 'create', target: { teamId: TEAM_B, createdById: null } }).ok).toBe(true)
  })
})
