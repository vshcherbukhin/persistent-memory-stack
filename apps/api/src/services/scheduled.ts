/**
 * persistent-memory-api — the Workers control plane (Phase 5).
 *
 * The api PRODUCES schedule changes (the worker consumes the pm.scheduled queue):
 * it reads the ScheduledJob rows (ownerPrisma — control table, no RLS) merged with
 * the live BullMQ schedulers + worker heartbeat, and mutates schedulers on
 * dashboard actions (pause/resume/run-now/edit-cron). The durable schedule lives in
 * the row; the BullMQ scheduler is reconciled to it on every mutation (and on
 * worker boot). RBAC is enforced at the routes (reads any-auth, mutations
 * superuser), mirroring /dashboard/services.
 */
import { ownerPrisma, Prisma } from '@pm/db'
import {
  makeScheduledQueue,
  makeIngestConnection,
  upsertSchedule,
  removeSchedule,
  runScheduleNow,
  listSchedules,
  catalogMeta,
  SCHEDULED_JOB_CATALOG,
  WORKER_HEARTBEAT_KEY,
  type ScheduledJobData,
} from '@pm/shared'
import type { Queue } from 'bullmq'
import { config } from '../config.ts'
import {
  buildWorkerView,
  computeLiveness,
  isPlausibleCron,
  type WorkerStatus,
  type WorkerLiveness,
} from './scheduled-view.ts'

/** One scheduled queue per api process (producer/manager side; worker consumes). */
export const scheduledQueue: Queue<ScheduledJobData> = makeScheduledQueue(
  makeIngestConnection(config.REDIS_URL),
)

/** A managed job that doesn't exist (unknown name, or no row yet — worker not booted). */
export class JobNotFoundError extends Error {
  readonly statusCode = 404 as const
  readonly code = 'job_not_found' as const
  constructor(name: string) {
    super(`No managed scheduled job named "${name}".`)
    this.name = 'JobNotFoundError'
  }
}

/** A cron pattern the api rejects before it reaches BullMQ. */
export class InvalidCronError extends Error {
  readonly statusCode = 400 as const
  readonly code = 'invalid_cron' as const
  constructor(pattern: string) {
    super(`"${pattern}" is not a valid cron pattern (expected 5 or 6 space-separated fields).`)
    this.name = 'InvalidCronError'
  }
}

/** Reject a name that isn't a registered job (only catalog jobs are manageable). */
function assertKnown(name: string): void {
  if (!catalogMeta(name)) throw new JobNotFoundError(name)
}

/** Translate Prisma "record not found" (row absent — worker never booted) → 404. */
function asNotFound(name: string, err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    throw new JobNotFoundError(name)
  }
  throw err
}

export interface WorkersView {
  workers: WorkerStatus[]
  liveness: WorkerLiveness
}

export async function listScheduledJobs(): Promise<WorkersView> {
  const rows = await ownerPrisma.scheduledJob.findMany({ orderBy: { name: 'asc' } })
  // The live scheduler info + heartbeat are best-effort: if Redis is unreachable
  // the rows still render (next-run + liveness degrade rather than 500 the page).
  let schedules: Awaited<ReturnType<typeof listSchedules>> = []
  let beat: string | null = null
  try {
    schedules = await listSchedules(scheduledQueue)
    const client = await scheduledQueue.client
    beat = await client.get(WORKER_HEARTBEAT_KEY)
  } catch (err) {
    console.warn(
      'WARN: [workers] live scheduler/heartbeat read failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
  return {
    workers: buildWorkerView(rows, schedules, SCHEDULED_JOB_CATALOG),
    liveness: computeLiveness(beat, Date.now()),
  }
}

export interface JobLog {
  name: string
  status: string
  logTail: string | null
  lastError: string | null
  lastRunAt: string | null
  lastFinishAt: string | null
}

export async function jobLog(name: string): Promise<JobLog> {
  assertKnown(name)
  const row = await ownerPrisma.scheduledJob.findUnique({ where: { name } })
  if (!row) throw new JobNotFoundError(name)
  return {
    name: row.name,
    status: row.status,
    logTail: row.logTail,
    lastError: row.lastError,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastFinishAt: row.lastFinishAt?.toISOString() ?? null,
  }
}

export async function pauseJob(name: string): Promise<void> {
  assertKnown(name)
  // Persist disabled FIRST (the row is the source of truth) THEN drop the scheduler.
  // If a stray tick fires in between, the worker processor sees enabled=false and skips.
  try {
    await ownerPrisma.scheduledJob.update({ where: { name }, data: { enabled: false } })
  } catch (err) {
    return asNotFound(name, err)
  }
  await removeSchedule(scheduledQueue, name)
}

export async function resumeJob(name: string): Promise<void> {
  assertKnown(name)
  let cron: string
  try {
    const row = await ownerPrisma.scheduledJob.update({ where: { name }, data: { enabled: true } })
    cron = row.cron
  } catch (err) {
    return asNotFound(name, err)
  }
  await upsertSchedule(scheduledQueue, name, cron)
}

export async function runJobNow(name: string): Promise<void> {
  assertKnown(name)
  // run-now is independent of the row; require the job be registered (above) only.
  await runScheduleNow(scheduledQueue, name)
}

/** Edit the schedule (cron and/or enabled). Validates cron BEFORE persisting. */
export async function editJob(
  name: string,
  patch: { cron?: string; enabled?: boolean },
): Promise<void> {
  assertKnown(name)
  if (patch.cron !== undefined && !isPlausibleCron(patch.cron)) throw new InvalidCronError(patch.cron)

  let row
  try {
    row = await ownerPrisma.scheduledJob.findUnique({ where: { name } })
  } catch (err) {
    return asNotFound(name, err)
  }
  if (!row) throw new JobNotFoundError(name)

  const cron = patch.cron ?? row.cron
  const enabled = patch.enabled ?? row.enabled

  if (enabled) {
    // Enabled: upsert the scheduler FIRST — BullMQ's cron-parser is the real
    // validator, so a bad-but-plausible pattern throws here BEFORE we persist the
    // row (no partial state). Then persist.
    await upsertSchedule(scheduledQueue, name, cron)
    await ownerPrisma.scheduledJob.update({ where: { name }, data: { cron, enabled } })
  } else {
    // Disabled: persist FIRST (the row is the source of truth) THEN drop the
    // scheduler — no upsert→remove window. The cron was plausibility-checked above
    // and is re-validated by BullMQ on resume. A stray tick is skipped by the worker
    // (it reads enabled=false).
    await ownerPrisma.scheduledJob.update({ where: { name }, data: { cron, enabled } })
    await removeSchedule(scheduledQueue, name)
  }
}
