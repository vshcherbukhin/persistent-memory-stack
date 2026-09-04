/**
 * Step 4 — write Chunk rows (Postgres, pm_app via runInTenant).
 *
 * Idempotent on re-run: a retry after a partial write would otherwise hit the
 * @@unique([documentId, ordinal]) constraint, so we deleteMany({ documentId })
 * then createMany the deterministic chunk set (the chunker is pure → same text
 * yields the same ordinals). embeddingStatus starts 'pending' (the schema
 * default); Mode A's step 5 flips its rows to 'embedded'.
 *
 * Returns the persisted rows ({ id, ordinal, content }) so step 5 can embed +
 * write qdrantPointId back keyed by id.
 */
import { runInTenant } from '@pm/db'
import type { Chunk, IngestJobData } from '@pm/shared'

export interface PersistedChunk {
  id: string
  ordinal: number
  content: string
}

export async function persistChunks(
  job: IngestJobData,
  chunks: Chunk[],
): Promise<PersistedChunk[]> {
  return runInTenant<PersistedChunk[]>(async (tx) => {
    // Idempotent re-run: clear any prior chunks for this document first.
    await tx.chunk.deleteMany({ where: { documentId: job.documentId } })
    if (chunks.length > 0) {
      await tx.chunk.createMany({
        data: chunks.map((c) => ({
          teamId: job.teamId, // server-stamped; RLS WITH CHECK backstops it
          project: job.project,
          documentId: job.documentId,
          ordinal: c.ordinal,
          content: c.content,
          tokenCount: c.tokenCount,
          embeddingStatus: 'pending' as const, // Mode-B default; Mode A flips later
          metadata: c.page != null ? { page: c.page } : undefined,
        })),
      })
    }
    const rows = (await tx.chunk.findMany({
      where: { documentId: job.documentId },
      select: { id: true, ordinal: true, content: true },
      orderBy: { ordinal: 'asc' },
    })) as PersistedChunk[]
    return rows
  })
}
