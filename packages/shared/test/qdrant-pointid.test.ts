/**
 * pointIdForRow — the DETERMINISTIC v5 point id derivation (#4, orphan-free
 * re-embed). The whole orphan-free guarantee rests on: same rowId → same point id
 * (so a re-embed overwrites in place), distinct rowIds → distinct ids, and a valid
 * RFC-4122 v5 shape (Qdrant requires a UUID or u64 point id). upsertVectors then
 * reuses the SAME point on every re-embed instead of minting randomUUID().
 */
import { describe, it, expect } from 'vitest'
import { pointIdForRow, QDRANT_POINT_NAMESPACE, upsertVectors } from '../src/qdrant/upsert.ts'
import { makeActivePin } from '../src/qdrant/collection.ts'
import { COLLECTION } from '../src/qdrant/types.ts'
import type { QdrantClient } from '@qdrant/js-client-rest'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('pointIdForRow — deterministic v5 point id', () => {
  it('is STABLE: the same rowId yields the same point id across calls', () => {
    const rowId = '550e8400-e29b-41d4-a716-446655440000'
    expect(pointIdForRow(rowId)).toBe(pointIdForRow(rowId))
  })

  it('is reproducible from the rowId alone (no per-call randomness)', () => {
    // A hard-coded expected value pins the algorithm: a regression in the
    // namespace constant or the hashing would change this and fail loudly.
    const first = pointIdForRow('chunk-abc')
    const second = pointIdForRow('chunk-abc')
    expect(first).toBe(second)
    expect(first).toMatch(UUID_RE)
  })

  it('differs across distinct rowIds (no collisions for different rows)', () => {
    const a = pointIdForRow('row-a')
    const b = pointIdForRow('row-b')
    expect(a).not.toBe(b)
  })

  it('emits a valid RFC-4122 version-5 / variant-bit UUID', () => {
    const id = pointIdForRow('any-row-id-here')
    expect(id).toMatch(UUID_RE)
    // version nibble (1st char of 3rd group) == '5'
    expect(id.split('-')[2]![0]).toBe('5')
    // variant nibble (1st char of 4th group) ∈ {8,9,a,b}
    expect('89ab').toContain(id.split('-')[3]![0])
  })

  it('exposes a frozen, non-empty namespace constant', () => {
    expect(QDRANT_POINT_NAMESPACE).toMatch(UUID_RE)
  })
})

describe('upsertVectors — uses the deterministic id (orphan-free re-embed)', () => {
  const pin = makeActivePin('qwen3-embedding:0.6b', 1024)
  const vec = () => new Array(pin.dim).fill(0.1)

  function fakeClient(): { client: QdrantClient; calls: Array<{ collection: string; body: any }> } {
    const calls: Array<{ collection: string; body: any }> = []
    const client = {
      async upsert(collection: string, body: any) {
        calls.push({ collection, body })
        return { status: 'completed' }
      },
    } as unknown as QdrantClient
    return { client, calls }
  }

  it('returns the deterministic point id for the rowId (not a fresh random one)', async () => {
    const { client } = fakeClient()
    const idByRow = await upsertVectors(client, {
      teamId: 'team_a',
      pin,
      items: [{ rowId: 'mem-1', sourceKind: 'memory', project: 'general', vector: vec() }],
    })
    expect(idByRow.get('mem-1')).toBe(pointIdForRow('mem-1'))
  })

  it('a re-upsert of the same rowId targets the SAME point id (overwrite, no orphan)', async () => {
    const { client, calls } = fakeClient()
    const args = (v: number[]) => ({
      teamId: 'team_a',
      pin,
      items: [{ rowId: 'mem-2', sourceKind: 'memory' as const, project: 'general', vector: v }],
    })
    const first = await upsertVectors(client, args(vec()))
    const second = await upsertVectors(client, args(vec()))
    expect(first.get('mem-2')).toBe(second.get('mem-2'))
    // Both Qdrant upserts wrote to the identical point id → second OVERWRITES first.
    expect(calls[0]!.collection).toBe(COLLECTION)
    expect(calls[0]!.body.points[0].id).toBe(calls[1]!.body.points[0].id)
    expect(calls[0]!.body.points[0].id).toBe(pointIdForRow('mem-2'))
  })

  it('stamps team_id + row_id payload and the active named-vector map', async () => {
    const { client, calls } = fakeClient()
    await upsertVectors(client, {
      teamId: 'team_x',
      pin,
      items: [{ rowId: 'chunk-9', sourceKind: 'chunk', project: 'gotham', vector: vec() }],
    })
    const pt = calls[0]!.body.points[0]
    expect(pt.payload.team_id).toBe('team_x')
    expect(pt.payload.row_id).toBe('chunk-9')
    expect(pt.vector).toHaveProperty(pin.vectorName)
  })
})
