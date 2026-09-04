/**
 * worker/scheduled — the code registry of managed scheduled jobs.
 *
 * The static metadata (name / description / default cron) is single-sourced in
 * @pm/shared's SCHEDULED_JOB_CATALOG (the api reads it too, for the dashboard).
 * Here we attach each job's `run()` by name and zip them together. The processor
 * looks a handler up by name and runs it; `run()` returns a short summary the
 * processor stamps into ScheduledJob.logTail. To add a P6/P7/P8 job: add a catalog
 * entry in @pm/shared AND a runner below — the row + scheduler reconcile on boot.
 *
 * Handlers touch CONTROL tables only (owner-only) → ownerPrisma, no tenant scope.
 */
import { ownerPrisma } from '@pm/db'
import { SCHEDULED_JOB_CATALOG, type ScheduledJobMeta } from '@pm/shared'
import type { WorkerDeps } from '../deps.ts'
import { embedBackfill } from '../steps/embed-backfill.ts'
import { ingestReconciler } from '../steps/ingest-reconciler.ts'
import { piiScan } from '../steps/pii-scan.ts'
import { memoryGraphBackfill } from '../steps/memory-graph-backfill.ts'
import { graphLifecycle } from '../steps/graph-lifecycle.ts'

export interface ScheduledHandler extends ScheduledJobMeta {
  /** Run the job (given the worker deps); returns a short summary for logTail. */
  run: (deps: WorkerDeps) => Promise<string>
}

// keep 90 in sync with the 'usage-sweep' catalog description in @pm/shared.
const USAGE_RETENTION_DAYS = 90
const USAGE_RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** name → runner. Every catalog entry MUST have a matching runner (asserted below). */
const RUNNERS: Record<string, (deps: WorkerDeps) => Promise<string>> = {
  // usage-sweep — drop model_usage_rollup rows older than 90 days (the dashboard's
  // window cap). Migrated off the worker's raw setInterval (Phase 5). Ignores deps.
  'usage-sweep': async () => {
    const cutoff = new Date(Date.now() - USAGE_RETENTION_MS)
    const { count } = await ownerPrisma.modelUsageRollup.deleteMany({
      where: { hourUtc: { lt: cutoff } },
    })
    return `deleted ${count} usage rollup row(s) older than ${USAGE_RETENTION_DAYS}d`
  },
  // embed-backfill — re-embed pending Memory/Chunk rows (Phase 6, Mode-A only).
  'embed-backfill': (deps) => embedBackfill(deps),
  // memory-graph-backfill — retry pending/failed Memory → Graphiti episode writes.
  'memory-graph-backfill': (deps) => memoryGraphBackfill(deps),
  'graph-lifecycle': (deps) => graphLifecycle(deps),
  // ingest-reconciler — re-queue ingest jobs stuck 'queued' with no live job (Phase 7).
  'ingest-reconciler': (deps) => ingestReconciler(deps),
  // pii-scan — periodic DLP safety net over stored memories/chunks (Phase 8).
  'pii-scan': (deps) => piiScan(deps),
}

export const SCHEDULED_HANDLERS: ScheduledHandler[] = SCHEDULED_JOB_CATALOG.map((meta) => {
  const run = RUNNERS[meta.name]
  if (!run) throw new Error(`scheduled job "${meta.name}" is in the catalog but has no runner`)
  return { ...meta, run }
})

export function findHandler(name: string): ScheduledHandler | undefined {
  return SCHEDULED_HANDLERS.find((h) => h.name === name)
}
