/**
 * Step 5 (Mode A) — embed chunks via the server embedder, upsert team-stamped
 * vectors into Qdrant, then write qdrant_point_id + embedding_status=embedded
 * back to each Chunk (pm_app, RLS-scoped). Mode B never reaches here (no
 * embedder); chunks stay 'pending' for the P8 client-bridge backfill.
 */
import { runInTenant } from '@pm/db'
import { upsertVectors, type IngestJobData } from '@pm/shared'
import type { WorkerDeps } from '../deps.ts'
import type { PersistedChunk } from './persist-chunks.ts'
import { withWorkerEmbeddingHealth } from '../embedding-health.ts'

export async function embedAndUpsert(
  deps: WorkerDeps,
  job: IngestJobData,
  chunkRows: PersistedChunk[],
): Promise<number> {
  const embedder = deps.embedder
  if (!embedder) throw new Error('Mode A worker reached embed step without an embedder.')
  if (chunkRows.length === 0) return 0

  // Embed (batched + retried inside the adapter). kind 'document' for stored chunks.
  const { vectors } = await withWorkerEmbeddingHealth(
    embedder,
    () => embedder.embed(chunkRows.map((c) => c.content), 'document'),
  )

  // Upsert team-stamped (the Qdrant payload is the tenant boundary). rowId → pointId.
  const idByRow = await upsertVectors(deps.qdrant, {
    teamId: job.teamId, // server-stamped, from the job
    pin: deps.pin,
    items: chunkRows.map((c, i) => ({
      rowId: c.id,
      sourceKind: 'chunk' as const,
      project: job.project,
      vector: vectors[i]!,
      documentId: job.documentId, // P11: payload document_id → filter-delete on re-version
    })),
  })

  // Write qdrant_point_id + embedding bookkeeping back (one tx, RLS-scoped).
  await runInTenant(async (tx) => {
    for (const c of chunkRows) {
      await tx.chunk.update({
        where: { id: c.id },
        data: {
          qdrantPointId: idByRow.get(c.id),
          embeddingModelId: deps.pin.modelId,
          embeddingDim: deps.pin.dim,
          embeddingStatus: 'embedded',
        },
      })
    }
  })
  return chunkRows.length
}
