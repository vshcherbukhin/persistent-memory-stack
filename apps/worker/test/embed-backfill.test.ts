/**
 * Unit: planBackfillUpserts — the pure pairing/grouping for the embed-backfill.
 * Given pending rows + the vectors the embedder returned (aligned by index) +
 * the kind, it: drops rows whose embed produced NO vector (they stay pending and
 * retry next run), groups the rest by team into upsert items (Qdrant is upserted
 * per-team), and returns the rowIds to flip to 'embedded'.
 *
 * The DB scan + Ollama embed + Qdrant upsert are effectful (covered live); this
 * isolates the index-pairing + grouping + missing-vector handling.
 */
import { describe, it, expect } from 'vitest'
import { planBackfillUpserts, type BackfillRow } from '../src/steps/embed-backfill.ts'

const row = (id: string, teamId: string, project = 'general'): BackfillRow => ({ id, teamId, project })

describe('planBackfillUpserts', () => {
  it('groups rows by team into upsert items and flips all when every vector is present', () => {
    const rows = [row('m1', 'tA'), row('m2', 'tA', 'proj2'), row('m3', 'tB')]
    const vectors = [[0.1], [0.2], [0.3]]
    const { byTeam, flipRowIds } = planBackfillUpserts(rows, vectors, 'memory')

    expect([...byTeam.keys()].sort()).toEqual(['tA', 'tB'])
    expect(byTeam.get('tA')).toEqual([
      { rowId: 'm1', sourceKind: 'memory', project: 'general', vector: [0.1] },
      { rowId: 'm2', sourceKind: 'memory', project: 'proj2', vector: [0.2] },
    ])
    expect(byTeam.get('tB')).toEqual([
      { rowId: 'm3', sourceKind: 'memory', project: 'general', vector: [0.3] },
    ])
    expect(flipRowIds).toEqual(['m1', 'm2', 'm3'])
  })

  it('drops a row whose embed produced no vector (it stays pending, not flipped)', () => {
    const rows = [row('c1', 'tA'), row('c2', 'tA'), row('c3', 'tA')]
    const vectors = [[0.1], null, [0.3]] // c2 failed to embed
    const { byTeam, flipRowIds } = planBackfillUpserts(rows, vectors, 'chunk')

    expect(byTeam.get('tA')).toEqual([
      { rowId: 'c1', sourceKind: 'chunk', project: 'general', vector: [0.1] },
      { rowId: 'c3', sourceKind: 'chunk', project: 'general', vector: [0.3] },
    ])
    expect(flipRowIds).toEqual(['c1', 'c3'])
  })

  it('returns empty structures for no rows', () => {
    const { byTeam, flipRowIds } = planBackfillUpserts([], [], 'memory')
    expect(byTeam.size).toBe(0)
    expect(flipRowIds).toEqual([])
  })
})
