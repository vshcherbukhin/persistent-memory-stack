/**
 * @pm/shared/queue — the managed scheduled-worker contract (Phase 5, Prisma-free).
 *
 * A second BullMQ queue (`pm.scheduled`) carrying recurring background jobs
 * (currently the usage-rollup retention sweep; P6/P7/P8 add the embed-backfill,
 * ingest-reconciler, and PII scan). Each job is keyed by a stable `name` that maps
 * to a code-side handler in the worker (apps/worker/src/scheduled/registry.ts) and to a
 * `ScheduledJob` control-table row (the durable schedule). Execution is driven by
 * BullMQ **Job Schedulers** (upsertJobScheduler) — the modern repeatable-job API.
 *
 * This module is the thin BullMQ layer ONLY: the queue/worker factories + the
 * scheduler-management wrappers. The handler logic and all Postgres writes live in
 * the worker (which owns @pm/db). The api imports the queue + these wrappers to
 * manage schedulers from the dashboard (pause/resume/run-now/edit-cron); the worker
 * imports them to reconcile schedulers to the rows on boot and to consume the queue.
 */
import { Queue, Worker, type Processor, type ConnectionOptions } from 'bullmq'

export const SCHEDULED_QUEUE = 'pm.scheduled' as const

/**
 * The worker liveness key (set by the worker every 15s, TTL 60s). The compose
 * healthcheck probes it; the api reads it to render the Workers-page liveness
 * banner. Lives here so worker (writer) and api (reader) single-source the name.
 */
export const WORKER_HEARTBEAT_KEY = 'pm:worker:heartbeat' as const

/**
 * Static metadata for a managed scheduled job — the single source of truth for the
 * name / description / default cron, shared by the worker (which attaches run()) and
 * the api (which serves descriptions to the dashboard; the standalone admin app can't
 * import @pm/* so the api must pass them over HTTP). Add P6/P7/P8 jobs here.
 */
export interface ScheduledJobMeta {
  name: string
  description: string
  defaultCron: string
}

export const SCHEDULED_JOB_CATALOG: readonly ScheduledJobMeta[] = [
  {
    name: 'usage-sweep',
    description: 'Delete model-usage rollups older than 90 days (Usage-page retention).',
    defaultCron: '0 3 * * *', // daily at 03:00 UTC
  },
  {
    name: 'embed-backfill',
    description:
      'Embed memories/chunks left pending (server-managed safety net for failed/edited embeds). client-managed embeddings no-ops — the client bridge owns embedding.',
    defaultCron: '*/15 * * * *', // every 15 minutes
  },
  {
    name: 'memory-graph-backfill',
    description:
      'Retry memory Graphiti episodes left pending/failed after normal memory create/update/import writes.',
    defaultCron: '*/15 * * * *', // every 15 minutes
  },
  {
    name: 'graph-lifecycle',
    description:
      'Reliably remove Graphiti episodes queued by a Memory or Document deletion; retries until provenance-aware removal is verified.',
    defaultCron: '*/2 * * * *',
  },
  {
    name: 'ingest-reconciler',
    description:
      'Re-queue ingest jobs stuck "queued" with no live worker job (recovers a crash between the row commit and the enqueue).',
    defaultCron: '*/10 * * * *', // every 10 minutes
  },
  {
    name: 'pii-scan',
    description:
      'DLP safety net: re-scan stored memories/chunks (Presidio + gitleaks) for PII/secrets that predate or slipped the write-gate, raise SecurityAlerts, and notify.',
    defaultCron: '0 2 * * *', // daily at 02:00 UTC
  },
]

/** Jobs deliberately removed from the product that an update must fully retire. */
export const RETIRED_SCHEDULED_JOB_NAMES = ['memory-archive'] as const

export function catalogMeta(name: string): ScheduledJobMeta | undefined {
  return SCHEDULED_JOB_CATALOG.find((m) => m.name === name)
}

/** One scheduled run. `manual` marks a dashboard "run now" (vs a scheduler tick). */
export interface ScheduledJobData {
  name: string
  manual?: boolean
}

/** Job return value — a short human summary the worker stamps into `logTail`. */
export interface ScheduledJobResult {
  summary: string
}

export function makeScheduledQueue(connection: ConnectionOptions): Queue<ScheduledJobData> {
  return new Queue<ScheduledJobData>(SCHEDULED_QUEUE, {
    connection,
    defaultJobOptions: {
      // A cron job that fails just runs again next tick — no aggressive retry that
      // would double-run a sweep. The ScheduledJob row records the failure.
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3600, count: 200 },
    },
  })
}

export interface ScheduledWorkerOpts {
  connection: ConnectionOptions
  /** Light jobs; keep a few slots so one slow job never blocks the others (default 4). */
  concurrency?: number
  /** ms; a scan job (P8) can be slow → 5 min default. */
  lockDuration?: number
}

export function makeScheduledWorker(
  processor: Processor<ScheduledJobData, ScheduledJobResult>,
  opts: ScheduledWorkerOpts,
): Worker<ScheduledJobData, ScheduledJobResult> {
  return new Worker<ScheduledJobData, ScheduledJobResult>(SCHEDULED_QUEUE, processor, {
    connection: opts.connection,
    concurrency: opts.concurrency ?? 4,
    lockDuration: opts.lockDuration ?? 300_000,
  })
}

// ── Scheduler management — thin BullMQ wrappers (no DB). The scheduler id == name. ──

/** A live scheduler view (from BullMQ), merged with the ScheduledJob row at the api. */
export interface ScheduleInfo {
  name: string
  pattern: string | null
  /** Epoch ms of the next scheduled run, or null if unknown. */
  next: number | null
}

/** Idempotently create/update the scheduler for `name` to fire on `cron`. Throws on
 *  an invalid cron pattern (BullMQ's cron-parser validates) — the caller maps → 400. */
export async function upsertSchedule(
  queue: Queue<ScheduledJobData>,
  name: string,
  cron: string,
): Promise<void> {
  await queue.upsertJobScheduler(name, { pattern: cron }, { name, data: { name } })
}

/** Remove the scheduler for `name` (pause). Returns false if none existed. */
export async function removeSchedule(
  queue: Queue<ScheduledJobData>,
  name: string,
): Promise<boolean> {
  return queue.removeJobScheduler(name)
}

/** Enqueue a one-off immediate run WITHOUT touching the schedule ("run now"). */
export async function runScheduleNow(
  queue: Queue<ScheduledJobData>,
  name: string,
): Promise<string> {
  const job = await queue.add(name, { name, manual: true })
  return job.id!
}

/** List the live schedulers (name + pattern + next-run). */
export async function listSchedules(queue: Queue<ScheduledJobData>): Promise<ScheduleInfo[]> {
  const rows = await queue.getJobSchedulers()
  // `key` IS the scheduler id we passed to upsertJobScheduler (== the job name);
  // it is always populated by BullMQ. (`name` is the job-template name, also == name.)
  return rows.map((r) => ({
    name: r.key,
    pattern: r.pattern ?? null,
    next: r.next ?? null,
  }))
}
