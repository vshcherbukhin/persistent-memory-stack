/**
 * Phase 11 (#6) document lifecycle — content-hash dedup / version-in-place.
 *
 * The api detects a RE-UPLOAD by (teamId, project, filename) and reuses the prior
 * Document id, so the worker sees the SAME documentId with a possibly-changed blob.
 * After extraction the worker hashes the normalized text and compares it to the
 * Document's stored contentHash:
 *   • no prior hash      → 'first'      (set hash, versionNumber stays 1)
 *   • hash unchanged     → 'unchanged'  (SKIP re-chunk/embed/graph — pure dedup)
 *   • hash changed       → 'changed'    (bump versionNumber IN PLACE, re-chunk/embed,
 *                                        drop the prior version's orphan Qdrant points,
 *                                        flag derived memories so the agent reconciles)
 *
 * contentHash + versionNumber are written ONLY on success (finalizeDocumentVersion,
 * step 7) — a failed ingest must re-process on retry, not be skipped.
 */
import { createHash } from 'node:crypto'
import { runInTenant, type Tx } from '@pm/db'
import { withSystemTenant } from '../tenant.ts'

export type IngestAction = 'first' | 'unchanged' | 'changed'

/** Pure: which lifecycle branch a (re-)ingest takes. */
export function decideIngestAction(priorHash: string | null | undefined, newHash: string): IngestAction {
  if (!priorHash) return 'first'
  return priorHash === newHash ? 'unchanged' : 'changed'
}

/** sha256 hex of the normalized extracted text — the dedup/version identity. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Read the Document's stored lifecycle state (RLS-scoped, own team). */
export async function readPriorDocument(
  documentId: string,
): Promise<{ contentHash: string | null; versionNumber: number; sourceId: string } | null> {
  return runInTenant((tx: Tx) =>
    tx.document.findUnique({
      where: { id: documentId },
      select: { contentHash: true, versionNumber: true, sourceId: true },
    }),
  )
}


/**
 * Persist the new lifecycle state on a successful (re-)ingest: stamp contentHash,
 * bump versionNumber on a content change, and — on 'changed' — flag derived memories
 * (those whose sourceId points at this document's source) with metadata.sourceUpdated
 * so the human/agent re-validates. The memory flag goes through the global-admin
 * maintenance path (withSystemTenant) because the worker is not the memories' owner —
 * the per-memory owner floor would otherwise block the update. (No doc→memory
 * extraction flow exists yet, so this flags 0 rows today; it is a ready seam.)
 */
export async function finalizeDocumentVersion(
  args: { documentId: string; sourceId: string; teamId: string; newHash: string; action: IngestAction; priorVersion: number },
): Promise<void> {
  await runInTenant((tx: Tx) =>
    tx.document.update({
      where: { id: args.documentId },
      data: {
        contentHash: args.newHash,
        versionNumber: args.action === 'changed' ? args.priorVersion + 1 : args.priorVersion,
      },
    }),
  )

  if (args.action === 'changed') {
    await withSystemTenant(() =>
      runInTenant(
        (tx: Tx) =>
          tx.$executeRaw`UPDATE memory
                         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{sourceUpdated}', 'true'::jsonb)
                         WHERE source_id = ${args.sourceId}::uuid`,
        { globalAdmin: true, teamIdOverride: args.teamId },
      ),
    ).catch(() => {})
  }
}

/** Stamp the current document episode and append immutable delete provenance. */
export async function stampDocumentGraphProvenance(args: {
  documentId: string
  teamId: string
  project: string
  groupId: string
  episodeId: string
}): Promise<void> {
  await runInTenant(async (tx: Tx) => {
    await tx.document.update({
      where: { id: args.documentId },
      data: { graphGroupId: args.groupId, graphEpisodeId: args.episodeId },
    })
    await tx.graphEpisodeProvenance.createMany({
      data: [{
        teamId: args.teamId,
        project: args.project,
        subjectKind: 'document',
        subjectId: args.documentId,
        graphGroupId: args.groupId,
        graphEpisodeId: args.episodeId,
      }],
      skipDuplicates: true,
    })
  })
}

/** Commit the graph pointer, immutable delete provenance, and graph success state together. */
export async function stampDocumentGraphSuccess(args: {
  ingestJobId: string
  documentId: string
  teamId: string
  project: string
  groupId: string
  episodeId: string
}): Promise<void> {
  await runInTenant(async (tx: Tx) => {
    await tx.document.update({ where: { id: args.documentId }, data: { graphGroupId: args.groupId, graphEpisodeId: args.episodeId } })
    await tx.graphEpisodeProvenance.createMany({
      data: [{ teamId: args.teamId, project: args.project, subjectKind: 'document', subjectId: args.documentId, graphGroupId: args.groupId, graphEpisodeId: args.episodeId }],
      skipDuplicates: true,
    })
    await tx.ingestJob.update({ where: { id: args.ingestJobId }, data: { graphStatus: 'ok' } })
  })
}
