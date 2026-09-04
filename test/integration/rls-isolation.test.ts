/**
 * Scenario B — RLS / team isolation + the mount ("grant") widening.
 *
 * Two teams A and B, each with a member + a distinct memory. The data-plane
 * search scope is own ∪ mounted (NOT universal) for plain members, so:
 *   1. Team A's member searches → finds A's memory, NOT B's (isolation).
 *   2. Create a mount: B grants A (TeamGrant grantor=B, grantee=A → A reads B).
 *   3. Team A's member searches again → now ALSO finds B's memory, tagged
 *      isOwnTeam=false / sourceTeam=B (the mount widens the MCP read scope).
 *
 * This proves the RLS memory-read floor (own ∪ mounted) end to end: the Qdrant
 * fan-out is bounded by readableTeamIds AND the Postgres hydrate is RLS-scoped.
 *
 * Route shapes: api/src/routes/memories.ts (POST /memories, POST /memories/search),
 * api/src/routes/dashboard/grants.ts (POST /dashboard/grants {grantorTeamId,granteeTeamId}).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api } from './client.ts'
import {
  bootstrapToken,
  provisionTeamWithMember,
  createGrant,
  deleteGrant,
  teardownTeamWithMember,
  uniqueSuffix,
  type Team,
  type ProvisionedMember,
} from './provision.ts'

interface SearchResult {
  results: Array<{ id: string; content: string; sourceTeam: string; isOwnTeam: boolean }>
  counts: { own: number; other: number }
}

const admin = bootstrapToken()
const PROJECT = `it-rls-${uniqueSuffix()}`

let teamA: Team
let memberA: ProvisionedMember
let teamB: Team
let memberB: ProvisionedMember
let memIdA = ''
let memIdB = ''

const TAG = `rlstag${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`
// Meaningful, fixed entity names — the Shape gate's entity-quality rule rejects
// random alphanumeric suffixes. Test isolation is by TEAM (fresh per run) + the
// unique PROJECT, not by the entity name.
const ENTITY_A = `component_alpha_widget`
const ENTITY_B = `component_beta_widget`
const CONTENT_A = `[${ENTITY_A}] Team A secret about the alpha widget pipeline. Root cause: alpha config drift. Fix: pin the alpha version. Prevention: lock the alpha manifest.`
const CONTENT_B = `[${ENTITY_B}] Team B secret about the beta widget pipeline. Root cause: beta config drift. Fix: pin the beta version. Prevention: lock the beta manifest.`

async function addMemory(token: string, content: string, entity: string): Promise<string> {
  const res = await api<{ id: string }>('POST', '/memories', {
    token,
    body: {
      content,
      project: PROJECT,
      metadata: { category: 'gotcha', entities: [entity], source: 'gotcha-discovered' },
    },
  })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json.id
}

beforeAll(async () => {
  const a = await provisionTeamWithMember(admin, 'rlsA')
  const b = await provisionTeamWithMember(admin, 'rlsB')
  teamA = a.team
  memberA = a.member
  teamB = b.team
  memberB = b.member
  memIdA = await addMemory(memberA.token, CONTENT_A, ENTITY_A)
  memIdB = await addMemory(memberB.token, CONTENT_B, ENTITY_B)
})

afterAll(async () => {
  // Drop the grant first so teardown's memory purge / team delete is clean.
  await deleteGrant(admin, teamB.id, teamA.id)
  await teardownTeamWithMember(admin, teamA, memberA)
  await teardownTeamWithMember(admin, teamB, memberB)
})

describe('RLS isolation + mount widening (data plane)', () => {
  it('Team A sees its own memory but NOT Team B (own ∪ mounted, unmounted)', async () => {
    const res = await api<SearchResult>('POST', '/memories/search', {
      token: memberA.token,
      // Query mentions BOTH widgets; only A's should be reachable to A.
      body: { query: `widget pipeline secret ${TAG}`, project: PROJECT, limit: 50 },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const ids = res.json.results.map((r) => r.id)
    expect(ids, "A must see A's memory").toContain(memIdA)
    expect(ids, "A must NOT see B's memory before the mount").not.toContain(memIdB)
  })

  it('after B grants A (mount), A also reads B (cross-team MCP read)', async () => {
    // TeamGrant(grantor=B, grantee=A): B's data becomes readable by A.
    await createGrant(admin, teamB.id, teamA.id)

    const res = await api<SearchResult>('POST', '/memories/search', {
      token: memberA.token,
      body: { query: `widget pipeline secret ${TAG}`, project: PROJECT, limit: 50 },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const byId = new Map(res.json.results.map((r) => [r.id, r]))
    expect(byId.has(memIdA), "A still sees A's memory").toBe(true)
    expect(byId.has(memIdB), "A now sees B's memory via the mount").toBe(true)
    const bHit = byId.get(memIdB)!
    expect(bHit.sourceTeam).toBe(teamB.id)
    expect(bHit.isOwnTeam).toBe(false)
  })
})
