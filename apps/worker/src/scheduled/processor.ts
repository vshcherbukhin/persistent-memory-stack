/**
 * worker/scheduled — the BullMQ processor for the pm.scheduled queue.
 *
 * Looks the job's handler up by name, stamps the ScheduledJob row through its run
 * lifecycle (running → success | failed) with telemetry (duration, logTail, error,
 * errorCount), and returns the handler's summary. Telemetry writes are best-effort
 * (never mask the job result); a handler error is RE-THROWN so BullMQ records the
 * failure (the queue uses attempts=1, so there's no double-run retry).
 *
 * Handlers touch control tables only → no tenant scope needed (unlike the ingest
 * processor, which runs inside withWorkerTenant).
 */
import { ownerPrisma } from '@pm/db'
import type { Job, ScheduledJobData, ScheduledJobResult } from '@pm/shared'
import type { WorkerDeps } from '../deps.ts'
import { findHandler } from './registry.ts'

const LOG_TAIL_MAX = 2000

export function makeScheduledProcessor(deps: WorkerDeps) {
  return async (job: Job<ScheduledJobData, ScheduledJobResult>): Promise<ScheduledJobResult> => {
    const { name, manual } = job.data
    const handler = findHandler(name)
    if (!handler) throw new Error(`no scheduled handler registered for "${name}"`)

    // The ScheduledJob row is the source of truth for `enabled`. A scheduled (non-
    // manual) tick for a PAUSED job must NOT run — this makes pause authoritative
    // regardless of scheduler-removal timing (closes the editJob upsert/remove,
    // boot-reconcile, and lingering-scheduler races). A manual "run now" always runs.
    const row = await ownerPrisma.scheduledJob.findUnique({ where: { name } }).catch(() => null)
    if (!manual && row && !row.enabled) return { summary: 'skipped (disabled)' }

    const startedAt = new Date()
    await ownerPrisma.scheduledJob
      .update({ where: { name }, data: { status: 'running', lastRunAt: startedAt } })
      .catch((err) => warnTelemetry(name, err)) // best-effort; the run still proceeds

    try {
      const summary = await handler.run(deps)
      const finishedAt = new Date()
      await ownerPrisma.scheduledJob
        .update({
          where: { name },
          data: {
            status: 'success',
            lastFinishAt: finishedAt,
            lastDurationMs: finishedAt.getTime() - startedAt.getTime(),
            logTail: summary.slice(0, LOG_TAIL_MAX),
            lastError: null,
            errorCount: 0,
          },
        })
        .catch((err) => warnTelemetry(name, err))
      return { summary }
    } catch (err) {
      const finishedAt = new Date()
      const msg = err instanceof Error ? err.message : String(err)
      await ownerPrisma.scheduledJob
        .update({
          where: { name },
          data: {
            status: 'failed',
            lastFinishAt: finishedAt,
            lastDurationMs: finishedAt.getTime() - startedAt.getTime(),
            logTail: msg.slice(0, LOG_TAIL_MAX),
            lastError: msg.slice(0, LOG_TAIL_MAX),
            errorCount: { increment: 1 },
          },
        })
        .catch((e) => warnTelemetry(name, e))
      throw err
    }
  }
}

/** A telemetry write failed (e.g. the row was deleted mid-run) — surface it, don't
 *  mask the job result. The dashboard row may be momentarily stale; that's logged. */
function warnTelemetry(name: string, err: unknown): void {
  console.warn(`WARN: [scheduled] telemetry write failed for "${name}":`, err instanceof Error ? err.message : String(err))
}
