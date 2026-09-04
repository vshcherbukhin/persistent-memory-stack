/**
 * persistent-memory-worker — the 7-step ingest orchestrator (the processor body).
 *
 * The ENTIRE body runs inside the ALS tenant scope (withWorkerTenant) so every
 * nested runInTenant() sets app.team_id = job.teamId on its own tx connection
 * (the worker tenant-bridge gotcha — must be run(), not enterWith()).
 *
 * Steps: 1 fetch original (MinIO) → 2 extract text (+ artifacts back to MinIO) →
 * 3 chunk → 4 persist Chunk rows → 5 embed (Mode A) | leave pending (Mode B) →
 * 6 Graphiti add_episode (best-effort; stamps IngestJob.graphStatus
 * ok/failed/skipped so the "in Qdrant but not the graph" partial state is
 * queryable — issue #9) → 7 IngestJob → completed. On any throw: stamp
 * status=failed + attempts + error, re-throw → BullMQ retries; final attempt
 * stays 'failed'.
 */
import {
  artifactKey,
  putStream,
  getBufferCapped,
  FileTooLargeError,
  removeObject,
  extractText,
  chunkText,
  deleteChunkPointsForDocument,
  type IngestJobData,
  type IngestJobResult,
  type Job,
} from '@pm/shared'
import { dlpGate } from '@pm/security-dlp'
import { withWorkerTenant } from './tenant.ts'
import type { WorkerDeps } from './deps.ts'
import { persistChunks } from './steps/persist-chunks.ts'
import { embedAndUpsert } from './steps/embed.ts'
import { postEpisode } from './steps/graphiti.ts'
import { setStatus, setGraphStatus } from './steps/status.ts'
import { recordSecurityAlerts } from './steps/security.ts'
import {
  decideIngestAction,
  hashText,
  readPriorDocument,
  finalizeDocumentVersion,
  stampDocumentGraphSuccess,
} from './steps/document-version.ts'
import { notifyAlert } from './notify.ts'
import { deriveProjectGraphGroup } from '@pm/graph'
import { GraphitiClient } from '@pm/graph'
import { randomUUID } from 'node:crypto'
import { runInTenant, type Tx } from '@pm/db'
import { config } from './config.ts'

export function makeIngestProcessor(deps: WorkerDeps) {
  return async (job: Job<IngestJobData, IngestJobResult>): Promise<IngestJobResult> => {
    const data = job.data
    const mode = deps.embeddingMode

    return withWorkerTenant(data, async () => {
      try {
        // ── 1. fetch original from MinIO (BOUNDED read — Phase 12, #8) ────
        // getBufferCapped aborts past deps.maxFileBytes so an over-cap blob can't OOM
        // the worker. Too-large is TERMINAL (no retry — re-running won't shrink it):
        // fail the job + RETURN, exactly like the DLP block.
        await setStatus(data.ingestJobId, 'extracting', job.attemptsMade)
        let bytes: Buffer
        try {
          bytes = await getBufferCapped(deps.minio, data.minioObjectKey, deps.maxFileBytes)
        } catch (err) {
          if (err instanceof FileTooLargeError) {
            // Terminal — fail the job + RETURN. Do NOT purge the blob (unlike the DLP
            // block): the api already committed the Source/Document rows pointing at it,
            // so purging would leave a dangling Document→blob ref. In the normal config
            // (worker cap == api upload cap) this never fires — the api rejects >cap
            // before creating any rows; it triggers only on an out-of-band blob or a
            // worker-cap < api-cap misconfig, where DELETE /documents/:id is the cleanup.
            await setStatus(
              data.ingestJobId,
              'failed',
              job.attemptsMade,
              `file_too_large: exceeds ${deps.maxFileBytes} bytes`,
            )
            void job.log(`ingest BLOCKED: file exceeds ${deps.maxFileBytes}-byte worker cap`)
            return { chunks: 0, embedded: 0, mode }
          }
          throw err
        }

        // ── 2. extract text (+ artifacts back to MinIO) ───────────────────
        const doc = await extractText({
          bytes,
          mime: data.mimeType,
          filename: data.filename,
        })

        // ── 2b. DLP gate (Phase 8): scan the extracted text BEFORE anything is
        // persisted. On detection: purge the original blob, raise SecurityAlert(s),
        // notify (best-effort), mark the job failed/pii_detected, and RETURN — no
        // throw (this is terminal, not retryable: re-running won't change the
        // content) so no chunks/vectors/graph/artifacts are ever created for the
        // sensitive document. FAIL-CLOSED: a scanner error also blocks here.
        if (deps.piiIngestGateEnabled) {
          const gate = await dlpGate(deps.dlpClient, doc.text, {
            entities: deps.piiEntities,
            scoreThreshold: deps.piiScoreThreshold,
          })
          if (gate.blocked) {
            const types = gate.findings.map((f) => f.findingType).join(', ')
            await removeObject(deps.minio, data.minioObjectKey).catch(() => {})
            await recordSecurityAlerts(gate.findings, {
              teamId: data.teamId,
              project: data.project,
              sourceKind: 'ingest',
              rowId: data.documentId,
            }).catch((e) => void job.log(`securityAlert write failed (non-fatal): ${String(e)}`))
            await notifyAlert(data.teamId, {
              subject: `Sensitive data blocked on ingest: ${data.filename}`,
              body:
                `Document ${data.documentId} (project ${data.project}) was BLOCKED by the DLP gate ` +
                `[${types}]. The uploaded file was purged; no chunks, vectors, or graph were created.`,
              severity: 'high',
            }).catch(() => 0)
            await setStatus(data.ingestJobId, 'failed', job.attemptsMade, `pii_detected: ${types}`)
            void job.log(`ingest BLOCKED by DLP gate: ${types}`)
            return { chunks: 0, embedded: 0, mode }
          }
        }

        // ── 2c. document-lifecycle decision (Phase 11, #6) ────────────────
        // Hash the normalized text and compare to what was last ingested for this
        // documentId (the api reuses the id on a same-filename re-upload). Unchanged
        // → SKIP the whole chunk/embed/graph churn (pure dedup). Changed/first →
        // proceed; on 'changed' the prior version's orphan Qdrant points are dropped
        // AFTER the new vectors land (no search blackout), and contentHash/version
        // are stamped only on success (step 7) so a failed ingest re-processes.
        const contentHash = hashText(doc.text)
        const prior = await readPriorDocument(data.documentId)
        const action = decideIngestAction(prior?.contentHash, contentHash)
        if (action === 'unchanged') {
          void job.log(`ingest deduped (content unchanged, v${prior?.versionNumber ?? 1}): ${data.filename}`)
          await setStatus(data.ingestJobId, 'completed', job.attemptsMade)
          return { chunks: 0, embedded: 0, mode }
        }

        for (const a of doc.artifacts) {
          const key = artifactKey({
            teamId: data.teamId,
            project: data.project,
            sourceId: data.sourceId,
            name: a.keySuffix,
          })
          await putStream(deps.minio, key, Buffer.from(a.body), a.contentType)
        }

        // ── 3. chunk ──────────────────────────────────────────────────────
        const chunks = chunkText(
          { text: doc.text, format: doc.format, pages: doc.pages },
          { maxTokens: deps.chunkMaxTokens, overlapTokens: deps.chunkOverlapTokens },
        )

        // ── 4. write Chunk rows (Postgres, pm_app via runInTenant) ─────────
        const chunkRows = await persistChunks(data, chunks)

        // ── 5. EMBEDDING (EMBEDDING_MODE-aware) ───────────────────────────
        // 'embedding' marks "extraction done, now embedding" — a crash mid-embed
        // leaves the row recoverable here and a retry re-enters cleanly (chunk
        // writes are idempotent on (documentId, ordinal)).
        await setStatus(data.ingestJobId, 'embedding', job.attemptsMade)
        let embedded = 0
        if (mode === 'server') {
          // Mode A: embed → Qdrant (team-stamped) → embedding_status=embedded.
          embedded = await embedAndUpsert(deps, data, chunkRows)
        }
        // Mode B (client-bridge): leave embedding_status=pending. The client
        // bridge backfills in P8 (rows found via the (team_id, embedding_status) index).

        // ── 5b. drop the PRIOR version's chunk points (P11, Mode A on a content
        // change). FILTER-delete by payload (document_id = this doc, row_id NOT IN the
        // new chunks) AFTER the new vectors land → no search blackout. Retry-robust:
        // the filter removes whatever stale points exist for the doc regardless of a
        // prior failed attempt (no reliance on collected ids), so a failed-then-retried
        // re-ingest leaves NO orphans. Mode A only — in Mode B the new points aren't
        // written yet (the bridge backfills), so deleting now would blank the doc.
        if (action === 'changed' && mode === 'server') {
          await deleteChunkPointsForDocument(
            deps.qdrant,
            data.documentId,
            chunkRows.map((c) => c.id),
          ).catch((e) => void job.log(`stale point cleanup failed (non-fatal): ${String(e)}`))
        }

        // ── 6. Graphiti add_episode (BEST-EFFORT — never fails the job) ───
        // The job still completes on a graph failure; graphStatus is what makes
        // the "in Qdrant but not the graph" partial state QUERYABLE (issue #9).
        // RE-RUN of graph-missing docs (graphStatus='failed') is NOT done here.
        // The scheduled memory-graph-backfill handles Memory rows only; document
        // graph retry remains a separate follow-up path.
        let graphitiEpisodeUuid: string | undefined
        const documentGeneration = action === 'changed'
          ? (prior?.versionNumber ?? 1) + 1
          : (prior?.versionNumber ?? 1)
        const documentEpisodeKey = `document:${data.documentId}:v${documentGeneration}:${contentHash}`
        const graphGroupId = deriveProjectGraphGroup({
          secret: config.GRAPH_GROUP_SECRET || config.TOKEN_PEPPER || 'local-development-graph-group-secret',
          teamId: data.teamId,
          project: data.project,
          surface: config.MEMORY_SURFACE ?? (config.DEPLOYMENT_MODE === 'local' ? 'personal' : 'shared'),
        })
        if (!deps.graphitiUrl) {
          // Graph disabled / not configured — episode intentionally not attempted.
          await setGraphStatus(data.ingestJobId, 'skipped')
        } else {
          try {
            graphitiEpisodeUuid = await postEpisode(deps.graphitiUrl, deps.graphitiTimeoutMs, {
              groupId: graphGroupId,
              name: `doc:${data.documentId}`,
              episodeBody: doc.text,
              referenceTime: new Date(),
              idempotencyKey: documentEpisodeKey,
              telemetry: { operationId: randomUUID(), subjectKind: 'document', subjectId: data.documentId, teamId: data.teamId, project: data.project, graphGroupId, stage: 'ingest-write' },
            })
          } catch (err) {
            void job.log(`graphiti add_episode failed (non-fatal): ${String(err)}`)
            // Persist a durable retry command. The lifecycle worker reads the
            // current document content and appends the recovered episode.
            await runInTenant((tx: Tx) => tx.graphLifecycleOperation.createMany({
              data: [{ teamId: data.teamId, project: data.project, subjectKind: 'document', subjectId: data.documentId, operation: 'replace', graphGroupId, graphEpisodeId: documentEpisodeKey }],
              skipDuplicates: true,
            }))
            await setGraphStatus(data.ingestJobId, 'failed').catch(() => {})
          }
          if (graphitiEpisodeUuid) {
            try {
              await stampDocumentGraphSuccess({
                ingestJobId: data.ingestJobId, documentId: data.documentId,
                teamId: data.teamId, project: data.project, groupId: graphGroupId, episodeId: graphitiEpisodeUuid,
              })
            } catch (stampError) {
              // A remote success without its UUID provenance is unsafe. Undo it
              // synchronously before allowing BullMQ to retry this ingest.
              await new GraphitiClient(deps.graphitiUrl, deps.graphitiTimeoutMs)
                .removeEpisode({ groupId: graphGroupId, episodeId: graphitiEpisodeUuid })
                .catch((compensationError) => {
                  throw new Error(`Document graph provenance failed (${String(stampError)}); compensating removal failed (${String(compensationError)}).`)
                })
              throw stampError
            }
          }
        }

        // ── 6b. stamp the document lifecycle state ON SUCCESS only (P11) ───
        // contentHash + versionNumber are written here (not before chunking) so a
        // failed ingest re-processes on retry instead of being skipped as "unchanged".
        // On a content change this also flags derived memories (sourceUpdated).
        await finalizeDocumentVersion({
          documentId: data.documentId,
          sourceId: data.sourceId,
          teamId: data.teamId,
          newHash: contentHash,
          action,
          priorVersion: prior?.versionNumber ?? 1,
        })

        // ── 7. IngestJob → completed ──────────────────────────────────────
        await setStatus(data.ingestJobId, 'completed', job.attemptsMade)

        return { chunks: chunkRows.length, embedded, graphitiEpisodeUuid, mode }
      } catch (err) {
        // Persist the failure; RE-THROW so BullMQ retries (attempts/backoff). The
        // status write must NOT mask the original error.
        await setStatus(data.ingestJobId, 'failed', job.attemptsMade, String(err)).catch(() => {})
        throw err
      }
    })
  }
}
