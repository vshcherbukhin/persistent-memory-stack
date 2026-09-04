/**
 * Qdrant filter builder — the leak-proof tenant filter searchVectors composes:
 *   • should = OR over readableTeamIds on team_id (tenant-OR, NEVER must).
 *   • must   = (project, source_kind) ANDed WITHIN the readable set.
 *   • composition = (≥1 should) AND (all must).
 *   • empty readableTeamIds → fail-closed (no query issued, [] returned).
 *   • query-vector dim must equal the active pin dim (loud guard).
 *
 * A captured-args fake QdrantClient lets us assert the filter shape without a
 * live Qdrant (the builder is pure given the client.query call).
 */
import { describe, it, expect } from 'vitest'
import { searchVectors } from '../src/qdrant/search.ts'
import type { SearchArgs } from '../src/qdrant/search.ts'
import { makeActivePin } from '../src/qdrant/collection.ts'
import { COLLECTION } from '../src/qdrant/types.ts'
import type { QdrantClient } from '@qdrant/js-client-rest'

interface Captured {
  collection?: string
  body?: any
}

function fakeClient(points: any[] = []): { client: QdrantClient; captured: Captured; calls: number } {
  const captured: Captured = {}
  let calls = 0
  const client = {
    async query(collection: string, body: any) {
      calls++
      captured.collection = collection
      captured.body = body
      return { points }
    },
  } as unknown as QdrantClient
  return {
    client,
    captured,
    get calls() {
      return calls
    },
  }
}

const pin = makeActivePin('qwen3-embedding:0.6b', 1024)
const vec = (n = pin.dim) => new Array(n).fill(0.1)

function args(over: Partial<SearchArgs> = {}): SearchArgs {
  return { queryVector: vec(), pin, readableTeamIds: ['team_a', 'team_b'], ...over }
}

describe('searchVectors filter builder', () => {
  it('builds should = OR over every readable team on team_id', async () => {
    const f = fakeClient()
    await searchVectors(f.client, args({ readableTeamIds: ['team_a', 'team_b', 'team_c'] }))
    expect(f.captured.collection).toBe(COLLECTION)
    expect(f.captured.body.filter.should).toEqual([
      { key: 'team_id', match: { value: 'team_a' } },
      { key: 'team_id', match: { value: 'team_b' } },
      { key: 'team_id', match: { value: 'team_c' } },
    ])
  })

  it('NEVER puts team_id in must (no AND-collapse to a single team)', async () => {
    const f = fakeClient()
    await searchVectors(f.client, args())
    const must = f.captured.body.filter.must ?? []
    expect(must.some((c: any) => c.key === 'team_id')).toBe(false)
  })

  it('preserves the own-first team order in should (caller merges own-first)', async () => {
    const f = fakeClient()
    await searchVectors(f.client, args({ readableTeamIds: ['own_team', 'granted_1', 'granted_2'] }))
    expect(f.captured.body.filter.should.map((c: any) => c.match.value)).toEqual([
      'own_team',
      'granted_1',
      'granted_2',
    ])
  })

  it('ANDs project + source_kind into must when supplied', async () => {
    const f = fakeClient()
    await searchVectors(f.client, args({ project: 'gotham', sourceKind: 'memory' }))
    expect(f.captured.body.filter.must).toEqual([
      { key: 'project', match: { value: 'gotham' } },
      { key: 'source_kind', match: { value: 'memory' } },
    ])
  })

  it('omits must entirely when neither project nor source_kind is set', async () => {
    const f = fakeClient()
    await searchVectors(f.client, args())
    expect('must' in f.captured.body.filter).toBe(false)
  })

  it('selects the active named vector via using and passes the limit through', async () => {
    const f = fakeClient()
    await searchVectors(f.client, args({ limit: 5 }))
    expect(f.captured.body.using).toBe(pin.vectorName)
    expect(f.captured.body.limit).toBe(5)
    expect(f.captured.body.with_payload).toBe(true)
  })

  it('defaults limit to 20 when unspecified', async () => {
    const f = fakeClient()
    await searchVectors(f.client, args())
    expect(f.captured.body.limit).toBe(20)
  })

  it('fail-closed: empty readableTeamIds (no allTeams) returns [] and issues NO query', async () => {
    const f = fakeClient([{ id: 'x', score: 1 }])
    const hits = await searchVectors(f.client, args({ readableTeamIds: [] }))
    expect(hits).toEqual([])
    expect(f.calls).toBe(0)
  })

  it('allTeams: true → universal read, NO team filter (should omitted)', async () => {
    const f = fakeClient([{ id: 'x', score: 1, payload: { team_id: 'any' } }])
    await searchVectors(f.client, args({ allTeams: true, readableTeamIds: undefined }))
    expect(f.calls).toBe(1)
    expect('should' in f.captured.body.filter).toBe(false)
  })

  it('rejects a query vector whose dim != active pin dim (loud, before any query)', async () => {
    const f = fakeClient()
    await expect(searchVectors(f.client, args({ queryVector: vec(512) }))).rejects.toThrow(
      /query vector dim 512 != active dim 1024/,
    )
    expect(f.calls).toBe(0)
  })

  it('flattens payload fields onto each returned hit', async () => {
    const f = fakeClient([
      {
        id: 'point-1',
        score: 0.87,
        payload: { row_id: 'mem-9', team_id: 'team_a', project: 'gotham', source_kind: 'memory' },
      },
    ])
    const hits = await searchVectors(f.client, args())
    expect(hits).toEqual([
      {
        pointId: 'point-1',
        rowId: 'mem-9',
        teamId: 'team_a',
        project: 'gotham',
        sourceKind: 'memory',
        score: 0.87,
      },
    ])
  })
})
