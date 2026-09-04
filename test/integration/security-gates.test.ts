/**
 * Scenario C — the Phase-2 security fixes are live.
 *
 * Three gates, all proven against the running stack:
 *   1. A plain member's `universal:true` on POST /memories/search is IGNORED
 *      (own ∪ mounted only — does NOT leak another team's memory).
 *   2. A plain member's GET /memories?universal=true is likewise IGNORED (the
 *      RLS app.read_all_memory escalation is admin-only).
 *   3. A team-admin importing/creating a memory into ANOTHER team via
 *      POST /dashboard/memories/import is rejected per-record (decideDashboard →
 *      cross_team_read_only → counted as an error, imported=0). A SUPER-admin
 *      importing the same cross-team record succeeds (imported=1).
 *
 * Route shapes:
 *   POST /memories/search  — api/src/routes/memories.ts (universal honored only admin+)
 *   GET  /memories         — api/src/routes/memories.ts (?universal coerced bool, admin+ only)
 *   POST /dashboard/memories/import — api/src/routes/dashboard/memories.ts
 *        body {memories:[{id,teamId,project,content,category,shape,entities,...}], teamId?}
 *        → 200 {imported,embedded,pending,errors}; per-record team authz via decideDashboard.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api } from './client.ts'
import {
  bootstrapToken,
  provisionTeamWithMember,
  setAdminLevel,
  teardownTeamWithMember,
  uniqueSuffix,
  type Team,
  type ProvisionedMember,
} from './provision.ts'

interface SearchResult {
  results: Array<{ id: string; sourceTeam: string; isOwnTeam: boolean }>
  counts: { own: number; other: number }
}
interface ListResult {
  results: Array<{ id: string; sourceTeam: string }>
  nextCursor: string | null
}
interface ImportResult {
  imported: number
  embedded: number
  pending: number
  errors: number
}

const admin = bootstrapToken()
const PROJECT = `it-sec-${uniqueSuffix()}`

// "victim" team holds a memory that the attacker member must never reach.
let victimTeam: Team
let victimMember: ProvisionedMember
// "attacker" team: one plain member + one team-admin (promoted).
let attackerTeam: Team
let attackerMember: ProvisionedMember
let attackerAdmin: ProvisionedMember
let victimMemId = ''

const TAG = `sectag${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`
const VICTIM_ENTITY = `component_victim_widget`
const VICTIM_CONTENT = `[${VICTIM_ENTITY}] Victim team confidential note about the secure widget. Root cause: leaked config. Fix: rotate the secret. Prevention: scope the secret to the team.`

beforeAll(async () => {
  const v = await provisionTeamWithMember(admin, 'secVictim')
  victimTeam = v.team
  victimMember = v.member

  const a = await provisionTeamWithMember(admin, 'secAttacker')
  attackerTeam = a.team
  attackerMember = a.member

  // A team-admin in their OWN (third) team. The cross-team import test only needs
  // this admin's team to DIFFER from the import target (the victim team), which
  // holds — so a dedicated team for the admin is the simplest valid fixture.
  const a2 = await provisionTeamWithMember(admin, 'secAdmin')
  attackerAdmin = a2.member
  await setAdminLevel(admin, attackerAdmin.id, 'admin')

  // Seed the victim memory through the victim's own data-plane write.
  const res = await api<{ id: string }>('POST', '/memories', {
    token: victimMember.token,
    body: {
      content: VICTIM_CONTENT,
      project: PROJECT,
      metadata: { category: 'gotcha', entities: [VICTIM_ENTITY], source: 'gotcha-discovered' },
    },
  })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  victimMemId = res.json.id
})

afterAll(async () => {
  await teardownTeamWithMember(admin, victimTeam, victimMember)
  await teardownTeamWithMember(admin, attackerTeam, attackerMember)
  // attackerAdmin lives in their own provisioned team (a2.team); purge via admin.
  await api('DELETE', `/dashboard/users/${attackerAdmin.id}`, { token: admin, body: { confirm: true } }).catch(() => {})
  if (attackerAdmin.teamId) {
    await api('DELETE', '/dashboard/memories', { token: admin, body: { teamId: attackerAdmin.teamId, confirm: true } }).catch(() => {})
    await api('DELETE', `/dashboard/teams/${attackerAdmin.teamId}`, { token: admin, body: { confirm: true } }).catch(() => {})
  }
})

describe('Phase-2 security gates', () => {
  it('a plain member POST /memories/search with universal:true is ignored (no leak)', async () => {
    const res = await api<SearchResult>('POST', '/memories/search', {
      token: attackerMember.token,
      body: { query: `secure widget confidential ${TAG}`, project: PROJECT, limit: 100, universal: true },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const ids = res.json.results.map((r) => r.id)
    expect(ids, 'universal:true must NOT leak the victim memory to a plain member').not.toContain(
      victimMemId,
    )
    // And nothing from the victim team should appear at all.
    expect(res.json.results.some((r) => r.sourceTeam === victimTeam.id)).toBe(false)
  })

  it('a plain member GET /memories?universal=true is ignored (no leak)', async () => {
    const res = await api<ListResult>('GET', '/memories', {
      token: attackerMember.token,
      query: { project: PROJECT, universal: true, limit: 100 },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const ids = res.json.results.map((r) => r.id)
    expect(ids, 'universal=true must NOT widen a plain member to all teams').not.toContain(
      victimMemId,
    )
    expect(res.json.results.some((r) => r.sourceTeam === victimTeam.id)).toBe(false)
  })

  it('a team-admin import into ANOTHER team is rejected (cross_team_read_only)', async () => {
    // Import a record whose teamId is the VICTIM team — not the admin's team.
    const recId = randomUUID()
    const ENTITY = `component_import_widget`
    const res = await api<ImportResult>('POST', '/dashboard/memories/import', {
      token: attackerAdmin.token,
      body: {
        memories: [
          {
            id: recId,
            teamId: victimTeam.id, // cross-team target → must be rejected for an admin
            project: PROJECT,
            content: `[${ENTITY}] Cross-team import attempt by a team-admin into the victim team about the import widget.`,
            category: 'gotcha',
            shape: 'gotcha_fix',
            entities: [ENTITY],
          },
        ],
      },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.imported, 'team-admin cross-team import must import 0').toBe(0)
    expect(res.json.errors, 'team-admin cross-team import must error the record').toBe(1)
  })

  it('a super-admin import into ANY team succeeds', async () => {
    const recId = randomUUID()
    const ENTITY = `component_superimport_widget`
    const res = await api<ImportResult>('POST', '/dashboard/memories/import', {
      token: admin, // bootstrap super-admin
      body: {
        memories: [
          {
            id: recId,
            teamId: victimTeam.id,
            project: PROJECT,
            content: `[${ENTITY}] Cross-team import by a super-admin into the victim team about the import widget.`,
            category: 'gotcha',
            shape: 'gotcha_fix',
            entities: [ENTITY],
          },
        ],
      },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.imported, 'super-admin cross-team import must succeed').toBe(1)
    expect(res.json.errors).toBe(0)
  })
})
