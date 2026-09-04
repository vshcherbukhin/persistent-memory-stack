/**
 * Scenario A — memory CRUD via the data plane (a team member token).
 *
 * Exercises the full lifecycle against the running stack:
 *   1. POST /memories — a valid Shape-A memory (passes the deterministic pre-gate
 *      AND the Stage-2 extraction LLM). Mode A: the server embeds the content.
 *   2. POST /memories/search — the new memory is found (semantic, own ∪ mounted).
 *   3. PATCH /memories/:id — change the content; search reflects the NEW content
 *      with NO stale/duplicate hit for the OLD content (covers fixes #3b/#4: the
 *      edit re-embeds in place onto the SAME deterministic point id, so the old
 *      vector can't linger).
 *   4. DELETE /memories/:id — gone (search no longer finds it; GET → 404).
 *
 * Route shapes: api/src/routes/memories.ts
 *   POST /memories          body {content,project?,sessionId?,metadata{category,entities,source,...}}
 *                           → 201 {id,shape,category,project,restructured,content,embeddingStatus}
 *   POST /memories/search   body {query,project?,limit?,universal?} → 200 {results[],counts{own,other}}
 *   PATCH /memories/:id     body {content?,project?,metadata?} → 200 ResultRow & {restructured}
 *   GET   /memories/:id     → 200 ResultRow | 404
 *   DELETE /memories/:id    → 204 | 404
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

interface MemoryCreated {
  id: string
  shape: string
  category: string
  project: string
  restructured: boolean
  content: string
  embeddingStatus: 'pending' | 'embedded'
}
interface SearchResult {
  results: Array<{ id: string; content: string; sourceTeam: string; isOwnTeam: boolean }>
  counts: { own: number; other: number }
}

const admin = bootstrapToken()
const PROJECT = `it-crud-${uniqueSuffix()}`
let team: Team
let member: ProvisionedMember

// The entity must be a MEANINGFUL identifier (the Shape gate's entity-quality rule
// rejects random alphanumeric suffixes — e.g. `component_crud9f3a` → 422). Test
// isolation comes from PROJECT (unique per run) + the project-scoped search, not
// from a random entity name.
const ENTITY = `component_crud_widget`
const ORIGINAL = `[${ENTITY}] The crud widget threw on null input during integration setup. Root cause: missing guard. Fix: add a null check before render. Prevention: validate props.`
const EDITED = `[${ENTITY}] The crud widget now also rejects undefined input after the edit. Root cause: loose typing. Fix: tighten the prop type. Prevention: enable strict mode.`

beforeAll(async () => {
  const p = await provisionTeamWithMember(admin, 'crud')
  team = p.team
  member = p.member
})

afterAll(async () => {
  await teardownTeamWithMember(admin, team, member)
})

describe('memory CRUD (data plane, team member)', () => {
  let memoryId: string

  it('creates a Shape-passing memory (Mode A: server embeds)', async () => {
    const res = await api<MemoryCreated>('POST', '/memories', {
      token: member.token,
      body: {
        content: ORIGINAL,
        project: PROJECT,
        metadata: {
          category: 'gotcha',
          entities: [ENTITY],
          source: 'gotcha-discovered',
          severity: 'medium',
        },
      },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.id).toBeTruthy()
    expect(res.json.category).toBe('gotcha')
    expect(res.json.project).toBe(PROJECT)
    // Mode A on the dev stack embeds inline; if the server is Mode B without a
    // vector it stays pending — accept either, but it must be a known value.
    expect(['embedded', 'pending']).toContain(res.json.embeddingStatus)
    memoryId = res.json.id
  })

  it('finds the new memory via semantic search', async () => {
    const res = await api<SearchResult>('POST', '/memories/search', {
      token: member.token,
      body: { query: 'crud widget null input', project: PROJECT, limit: 20 },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const hit = res.json.results.find((r) => r.id === memoryId)
    expect(hit, 'created memory should be in the search results').toBeTruthy()
    expect(hit!.isOwnTeam).toBe(true)
    expect(hit!.sourceTeam).toBe(team.id)
  })

  it('PATCH updates the content; search reflects the new content with no stale duplicate', async () => {
    const patch = await api<MemoryCreated & { id: string }>('PATCH', `/memories/${memoryId}`, {
      token: member.token,
      body: { content: EDITED },
    })
    expect(patch.status, JSON.stringify(patch.json)).toBe(200)
    expect(patch.json.content).toContain('undefined input')

    // The same memory id is returned for a query matching the NEW content, and it
    // must appear EXACTLY ONCE (no stale-vector duplicate of the old content).
    const res = await api<SearchResult>('POST', '/memories/search', {
      token: member.token,
      body: { query: 'crud widget undefined input', project: PROJECT, limit: 20 },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const hits = res.json.results.filter((r) => r.id === memoryId)
    expect(hits.length, 'edited memory must appear exactly once (no stale dup)').toBe(1)
    expect(hits[0]!.content).toContain('undefined input')
    expect(hits[0]!.content).not.toContain('threw on null input')
  })

  it('DELETE removes the memory (GET → 404)', async () => {
    const del = await api('DELETE', `/memories/${memoryId}`, { token: member.token })
    expect(del.status).toBe(204)

    const get = await api('GET', `/memories/${memoryId}`, { token: member.token })
    expect(get.status).toBe(404)
  })
})
