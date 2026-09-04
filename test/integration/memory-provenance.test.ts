/**
 * Scenario G — provenance and confidence lifecycle.
 *
 * Against the running stack:
 *   1. add_memory stamps provenance SERVER-SIDE from the source: an agent source
 *      (gotcha-discovered) → agent_inferred + a confidence; a human source
 *      (user-correction) → human_verified. tier defaults to semantic. The agent
 *      cannot self-assert provenance/confidence (memory-injection safety).
 *   2. search returns provenance plus write-time confidence. There is no manual
 *      verification or retention/archive override in the current model.
 *
 * The rerank ORDERING (fresh > stale, provenance × confidence) is
 * deterministically covered by the rerank unit test — not re-asserted here (semantic
 * ordering over live embeddings is non-deterministic).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api } from './client.ts'
import {
  bootstrapToken,
  provisionTeamWithMember,
  teardownTeamWithMember,
  uniqueSuffix,
  type Team,
  type ProvisionedMember,
} from './provision.ts'

const admin = bootstrapToken()
const PROJECT = `it-prov-${uniqueSuffix()}`
const ENTITY = `component_provenance_widget`
let team: Team
let member: ProvisionedMember
let agentMemId = ''

interface Created {
  id: string
  memoryTier: string
  sourceProvenance: string
  confidence: number
}
const content = (verb: string) =>
  `[${ENTITY}] The provenance widget ${verb} during the integration run. Root cause: missing guard. Fix: add a check. Prevention: validate inputs.`

beforeAll(async () => {
  const p = await provisionTeamWithMember(admin, 'prov')
  team = p.team
  member = p.member
})
afterAll(async () => {
  await teardownTeamWithMember(admin, team, member)
})

describe('Phase-9 provenance stamping', () => {
  it('an agent source → agent_inferred provenance + a confidence, tier semantic', async () => {
    const res = await api<Created>('POST', '/memories', {
      token: member.token,
      body: {
        content: content('threw'),
        project: PROJECT,
        metadata: { category: 'gotcha', entities: [ENTITY], source: 'gotcha-discovered', severity: 'medium' },
      },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.sourceProvenance).toBe('agent_inferred')
    expect(res.json.memoryTier).toBe('semantic')
    expect(typeof res.json.confidence).toBe('number')
    expect(res.json.confidence).toBeGreaterThanOrEqual(0)
    expect(res.json.confidence).toBeLessThanOrEqual(1)
    agentMemId = res.json.id
  })

  it('a human source → human_verified provenance (server-derived, not agent-asserted)', async () => {
    const res = await api<Created>('POST', '/memories', {
      token: member.token,
      body: {
        content: content('regressed'),
        project: PROJECT,
        metadata: { category: 'user-correction', entities: [ENTITY], source: 'user-correction', severity: 'low' },
      },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.sourceProvenance).toBe('human_verified')
    await api('DELETE', `/memories/${res.json.id}`, { token: member.token }).catch(() => {})
  })

  it('search returns static provenance and confidence without a manual verification field', async () => {
    const res = await api<{ results: Array<{ id: string; confidence?: number; sourceProvenance?: string }> }>(
      'POST',
      '/memories/search',
      { token: member.token, body: { query: 'provenance widget guard', project: PROJECT, limit: 20 } },
    )
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const hit = res.json.results.find((r) => r.id === agentMemId)
    expect(hit, 'created memory should be found').toBeTruthy()
    expect(hit).not.toHaveProperty('verified')
    expect(typeof hit!.confidence).toBe('number')
    expect(hit!.sourceProvenance).toBe('agent_inferred')
  })
})
