/**
 * Upsert chunk/memory vectors under the ACTIVE named vector.
 *
 *   • teamId is passed by the api from getCtx().teamId — NEVER a client arg. The
 *     Qdrant payload is the only tenant boundary here (no RLS), so the stamp is
 *     the first isolation layer, the read `should` filter the second.
 *   • point id = a DETERMINISTIC UUIDv5 of the Postgres rowId (see pointIdForRow).
 *     Same rowId → same point id every time, so a re-embed of the same row
 *     OVERWRITES its existing point instead of orphaning the old one. The id is
 *     still returned so the api writes it back to Chunk.qdrantPointId /
 *     Memory.qdrantPointId (the @db.Uuid column) and the delete-by-pointId purge
 *     paths keep working (the id is reproducible from the rowId alone).
 *   • named-vector collections take a vector MAP { "<name>": number[] }, not a
 *     bare array.
 *   • a per-item dim check turns a stale-registry / wrong-model write into a loud
 *     error instead of a silently-unsearchable point.
 *
 * Dual-write during a migration is handled by the switch tool (updateVectors with
 * the freshly TARGET-embedded vector), NOT by duplicating the active vector here
 * — the target vector has a different dim. See switch/migration.ts. (The switch
 * scrolls existing point ids, so it is unaffected by the id derivation here.)
 */
import { createHash } from 'node:crypto'
import type { QdrantClient } from '@qdrant/js-client-rest'
import type { ActivePin, VectorSourceKind } from '../types/index.ts'
import { COLLECTION } from './types.ts'

/**
 * Fixed namespace UUID for persistent-memory Qdrant point ids (a randomly
 * generated, then frozen, v4 UUID). Combined with a rowId under RFC-4122 §4.3 to
 * derive a stable v5 point id. MUST NOT change — changing it re-keys every point.
 */
export const QDRANT_POINT_NAMESPACE = '6f9a1d2e-7c34-4b8a-9e51-2a6f0c3d4b15'

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/**
 * Deterministic RFC-4122 v5 (SHA-1) UUID of `rowId` under QDRANT_POINT_NAMESPACE.
 * Stable + reproducible: the same rowId always yields the same point id, so a
 * re-embed overwrites the same Qdrant point (zero orphans) and the delete paths
 * can reconstruct the id from the rowId. Distinct rowIds yield distinct ids.
 */
export function pointIdForRow(rowId: string): string {
  const hash = createHash('sha1')
    .update(uuidToBytes(QDRANT_POINT_NAMESPACE))
    .update(Buffer.from(rowId, 'utf8'))
    .digest()
  const b = hash.subarray(0, 16)
  b[6] = (b[6]! & 0x0f) | 0x50 // version 5
  b[8] = (b[8]! & 0x3f) | 0x80 // RFC-4122 variant
  const hex = b.toString('hex')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

export interface UpsertVectorInput {
  rowId: string // Postgres Chunk/Memory id
  sourceKind: VectorSourceKind
  project: string
  vector: number[]
  /** Chunk points carry their documentId so the P11 re-version path can drop the
   *  PRIOR version's points by a payload FILTER (document_id=X, row_id NOT IN new) —
   *  retry-robust, vs. collecting fragile per-row point ids. Memories omit it. */
  documentId?: string
}

export interface UpsertArgs {
  teamId: string // server-stamped from identity
  pin: ActivePin
  items: UpsertVectorInput[]
}

/** Returns rowId → pointId so the caller writes qdrantPointId back to Postgres. */
export async function upsertVectors(
  client: QdrantClient,
  args: UpsertArgs,
): Promise<Map<string, string>> {
  const idByRow = new Map<string, string>()

  const points = args.items.map((it) => {
    if (it.vector.length !== args.pin.dim) {
      throw new Error(
        `qdrant upsert: vector for ${it.sourceKind} ${it.rowId} has dim ${it.vector.length}, ` +
          `expected active dim ${args.pin.dim} (model ${args.pin.modelId}). Re-embed with the pinned model.`,
      )
    }
    const pointId = pointIdForRow(it.rowId) // DETERMINISTIC: re-embed overwrites, no orphan
    idByRow.set(it.rowId, pointId)
    return {
      id: pointId,
      vector: { [args.pin.vectorName]: it.vector }, // NAMED-VECTOR MAP
      payload: {
        team_id: args.teamId, // server-stamped tenant boundary
        project: it.project,
        source_kind: it.sourceKind,
        row_id: it.rowId,
        embedding_model_id: args.pin.modelId,
        dim: args.pin.dim,
        ...(it.documentId ? { document_id: it.documentId } : {}),
      },
    }
  })

  if (points.length > 0) {
    await client.upsert(COLLECTION, { wait: true, points })
  }
  return idByRow
}

/**
 * Delete a document's chunk points by PAYLOAD FILTER (document_id == documentId),
 * optionally keeping a set of current row ids. Used by:
 *   • the P11 re-version path — pass the NEW chunks' row ids as `keepRowIds` to drop
 *     ONLY the prior version's points (after the new ones are written → no blackout).
 *     Filter-based, so it is RETRY-ROBUST: it removes whatever stale points exist for
 *     the doc regardless of a prior failed attempt (no reliance on collected ids).
 *   • DELETE /documents/:id — omit `keepRowIds` to drop ALL of the document's points
 *     (also sweeps any orphans from an earlier interrupted re-ingest).
 * Best-effort at the call site. (Points written before P11 carry no document_id and
 * are not matched — a one-time transitional residual for pre-existing docs.)
 */
export async function deleteChunkPointsForDocument(
  client: QdrantClient,
  documentId: string,
  keepRowIds: string[] = [],
): Promise<void> {
  const filter: Record<string, unknown> = {
    must: [{ key: 'document_id', match: { value: documentId } }],
  }
  if (keepRowIds.length > 0) {
    filter.must_not = [{ key: 'row_id', match: { any: keepRowIds } }]
  }
  await client.delete(COLLECTION, { wait: true, filter })
}
