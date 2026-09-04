/**
 * deleteChunkPointsForDocument — the P11 retry-robust filter-delete. Pins the Qdrant
 * filter shape: always `must document_id == X`; with a keep-set, `must_not row_id IN
 * keep` (re-version: drop only the prior version's points); without, no must_not
 * (DELETE route: drop ALL the doc's points incl. orphans).
 */
import { describe, it, expect, vi } from 'vitest'
import { deleteChunkPointsForDocument } from '../src/qdrant/upsert.ts'
import { COLLECTION } from '../src/qdrant/types.ts'
import type { QdrantClient } from '@qdrant/js-client-rest'

function fakeClient(): { client: QdrantClient; del: ReturnType<typeof vi.fn> } {
  const del = vi.fn(async () => ({}))
  return { client: { delete: del } as unknown as QdrantClient, del }
}

describe('deleteChunkPointsForDocument', () => {
  it('re-version: must document_id + must_not row_id IN keepRowIds', async () => {
    const { client, del } = fakeClient()
    await deleteChunkPointsForDocument(client, 'doc-1', ['r1', 'r2'])
    expect(del).toHaveBeenCalledOnce()
    const [collection, body] = del.mock.calls[0]!
    expect(collection).toBe(COLLECTION)
    expect(body.filter.must).toEqual([{ key: 'document_id', match: { value: 'doc-1' } }])
    expect(body.filter.must_not).toEqual([{ key: 'row_id', match: { any: ['r1', 'r2'] } }])
  })

  it('full delete (no keep-set): must document_id only, no must_not', async () => {
    const { client, del } = fakeClient()
    await deleteChunkPointsForDocument(client, 'doc-2')
    const body = del.mock.calls[0]![1]
    expect(body.filter.must).toEqual([{ key: 'document_id', match: { value: 'doc-2' } }])
    expect(body.filter.must_not).toBeUndefined()
  })
})
