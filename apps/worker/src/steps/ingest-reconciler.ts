/**
 * ingest-reconciler — re-queue lost ingest jobs (Phase 7, issue #7).
 *
 * The api commits Source+Document+IngestJob(queued) THEN enqueues a BullMQ job. If
 * the process dies BETWEEN the commit and the enqueue (or Redis loses the job), the
 * row is stuck `queued` with no live Bull job and the worker never sees it. (The api
 * also try/catches the enqueue and stamps `failed/enqueue_failed` for the case where
 * the enqueue itself throws synchronously — this job covers the crash/lost-job case
 * the try/catch can't, where the catch never runs.)
 *
 * This scan finds `queued` IngestJobs with NO live Bull job and re-enqueues them from
 * the canonical Source/Document rows. Idempotent: the Bull jobId === ingestJobId, so a
 * re-enqueue collapses if a job already exists. Cross-team by design → withSystemTenant
 * + the global-admin RLS path (NOT ownerPrisma on data tables), exactly like
 * embed-backfill.
 */
import { runInTenant, type Tx } from '@pm/db'
import { enqueueIngest, type IngestJobData } from '@pm/shared'
import type { WorkerDeps } from '../deps.ts'
import { withSystemTenant } from '../tenant.ts'

/** Per-run cap — bounded work; if the cap is hit, the next run continues. */
const BATCH = 200

/**
 * Only reconcile jobs older than this. The api enqueues milliseconds after the row
 * commits, so a brand-new `queued` row briefly has no live job through no fault — the
 * floor avoids fighting that normal path. The re-enqueue is idempotent anyway
 * (jobId === ingestJobId), so this is noise-reduction, not correctness.
 * ponytail: a 2-min floor is plenty; tighten only if lost jobs must recover faster.
 */
const MIN_AGE_MS = 2 * 60 * 1000

/** The columns the reconciler scan selects (IngestJob + its Source + first Document). */
export interface StuckJob {
  id: string
  teamId: string
  project: string
  sessionId: string | null
  sourceId: string | null
  source: {
    title: string | null
    minioObjectKey: string | null
    documents: { id: string; mimeType: string | null }[]
  } | null
}

export interface ReconcilePlan {
  payloads: IngestJobData[]
  /** Jobs skipped because a live Bull job already exists (the common, healthy case). */
  skippedLive: number
  /** Jobs whose Source/Document is too incomplete to rebuild a payload — left queued. */
  skippedUnreconstructable: number
}

/**
 * Pure: decide which stuck jobs to re-enqueue and rebuild each payload from the
 * canonical rows. A job with a live Bull job (id in `liveJobIds`) is left alone; a job
 * missing the source/key/document needed to rebuild the payload is left queued (it
 * would only fail again) and counted.
 */
export function planRequeue(jobs: StuckJob[], liveJobIds: Set<string>): ReconcilePlan {
  const payloads: IngestJobData[] = []
  let skippedLive = 0
  let skippedUnreconstructable = 0
  for (const job of jobs) {
    if (liveJobIds.has(job.id)) {
      skippedLive++
      continue
    }
    const src = job.source
    const doc = src?.documents[0]
    if (!job.sourceId || !src?.minioObjectKey || !src.title || !doc) {
      skippedUnreconstructable++
      continue
    }
    payloads.push({
      ingestJobId: job.id,
      sourceId: job.sourceId,
      documentId: doc.id,
      teamId: job.teamId,
      project: job.project,
      minioObjectKey: src.minioObjectKey,
      mimeType: doc.mimeType ?? 'application/octet-stream',
      filename: src.title,
      sessionId: job.sessionId,
    })
  }
  return { payloads, skippedLive, skippedUnreconstructable }
}

/** The scheduled-job entry point. Returns a short summary for ScheduledJob.logTail. */
export async function ingestReconciler(deps: WorkerDeps): Promise<string> {
  return withSystemTenant(async () => {
    const cutoff = new Date(Date.now() - MIN_AGE_MS)
    const jobs = (await runInTenant<StuckJob[]>(
      (tx: Tx) =>
        tx.ingestJob.findMany({
          where: { status: 'queued', createdAt: { lt: cutoff } },
          select: {
            id: true,
            teamId: true,
            project: true,
            sessionId: true,
            sourceId: true,
            source: {
              select: {
                title: true,
                minioObjectKey: true,
                documents: { select: { id: true, mimeType: true }, take: 1 },
              },
            },
          },
          take: BATCH,
          orderBy: { createdAt: 'asc' },
        }) as PromiseLike<StuckJob[]>,
      { globalAdmin: true, readOnly: true },
    )) as StuckJob[]
    if (jobs.length === 0) return 'nothing stuck'

    // Which of these still have a live Bull job (waiting/active/delayed/etc.)? Those
    // are tracked — leave them. getJob(jobId) → undefined means the job was lost.
    const liveIds = await Promise.all(
      jobs.map(async (j) => ((await deps.ingestQueue.getJob(j.id)) ? j.id : null)),
    )
    const liveJobIds = new Set(liveIds.filter((id): id is string => id !== null))

    const { payloads, skippedLive, skippedUnreconstructable } = planRequeue(jobs, liveJobIds)
    for (const payload of payloads) {
      await enqueueIngest(deps.ingestQueue, payload)
    }

    if (payloads.length === 0) {
      return skippedUnreconstructable > 0
        ? `nothing re-queued (${skippedLive} live, ${skippedUnreconstructable} unreconstructable)`
        : 'nothing stuck'
    }
    const capNote = jobs.length === BATCH ? ' (batch cap hit — next run continues)' : ''
    const skipNote = skippedUnreconstructable > 0 ? `, ${skippedUnreconstructable} unreconstructable` : ''
    return `re-queued ${payloads.length} stuck ingest job(s) (${skippedLive} already live${skipNote})${capNote}`
  })
}
