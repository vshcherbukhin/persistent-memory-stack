/**
 * Qdrant payload + result shapes. The payload is the ONLY tenant boundary in
 * Qdrant (no RLS there): team_id is server-stamped on write, filtered on read.
 */
import type { VectorSourceKind } from '../types/index.ts'

export const COLLECTION = 'memory_vectors'

/** Every point's payload. team_id + project both carry payload indexes. */
export interface QdrantPayload {
  team_id: string // server-stamped tenant boundary (is_tenant keyword index)
  project: string // "general" default; keyword index for filter narrowing
  source_kind: VectorSourceKind // 'chunk' | 'memory'
  row_id: string // canonical Postgres Chunk.id / Memory.id
  embedding_model_id: string
  dim: number
  document_id?: string // chunk points only (P11) — enables filter-delete on re-version/delete
}

/** A scored search hit, payload-flattened for the api/worker merge layer. */
export interface SearchHit {
  pointId: string
  rowId: string
  teamId: string
  project: string
  sourceKind: VectorSourceKind
  score: number
}
