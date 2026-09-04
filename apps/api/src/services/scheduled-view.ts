/**
 * persistent-memory-api — pure view-builders for the Workers control plane.
 *
 * Kept free of Redis/Prisma so the merge logic is unit-testable in isolation
 * (services/scheduled.ts wires these to ownerPrisma + the BullMQ queue). The api
 * presents a merged view: the durable ScheduledJob row (schedule + telemetry) +
 * the live BullMQ scheduler (next-run) + the static catalog (description).
 */
import type { ScheduleInfo, ScheduledJobMeta } from '@pm/shared'

/** The ScheduledJob columns the view needs (Date fields from Prisma). */
export interface ScheduledRow {
  name: string
  cron: string
  enabled: boolean
  status: string
  lastRunAt: Date | null
  lastFinishAt: Date | null
  lastDurationMs: number | null
  lastError: string | null
  logTail: string | null
  errorCount: number
}

/** The dashboard row shape (GET /dashboard/workers). All times are ISO strings. */
export interface WorkerStatus {
  name: string
  description: string
  cron: string
  enabled: boolean
  status: string
  lastRunAt: string | null
  lastFinishAt: string | null
  lastDurationMs: number | null
  lastError: string | null
  logTail: string | null
  errorCount: number
  nextRunAt: string | null
}

export interface WorkerLiveness {
  alive: boolean
  /** ms since the last heartbeat, or null if there has never been one. */
  lastBeatAgoMs: number | null
}

const HEARTBEAT_TTL_MS = 60_000

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export function buildWorkerView(
  rows: ScheduledRow[],
  schedules: ScheduleInfo[],
  catalog: readonly ScheduledJobMeta[],
): WorkerStatus[] {
  const byName = new Map(schedules.map((s) => [s.name, s]))
  return rows.map((r) => {
    const meta = catalog.find((m) => m.name === r.name)
    const sched = r.enabled ? byName.get(r.name) : undefined
    return {
      name: r.name,
      description: meta?.description ?? r.name,
      cron: r.cron,
      enabled: r.enabled,
      status: r.status,
      lastRunAt: iso(r.lastRunAt),
      lastFinishAt: iso(r.lastFinishAt),
      lastDurationMs: r.lastDurationMs,
      lastError: r.lastError,
      logTail: r.logTail,
      errorCount: r.errorCount,
      nextRunAt: sched?.next ? new Date(sched.next).toISOString() : null,
    }
  })
}

/**
 * Cheap sanity check for a cron pattern before handing it to BullMQ (whose
 * cron-parser is the real validator). Accepts 5 fields (min hour dom mon dow) or 6
 * (with a leading seconds field); each field must be made of digits and the cron
 * operators `* / , -`. Rejects empty input, wrong field counts, and macros like
 * `@daily` (BullMQ patterns don't support them). Friendly 400 for the common typo.
 */
export function isPlausibleCron(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/)
  if (fields.length < 5 || fields.length > 6) return false
  return fields.every((f) => /^[\d*/,\-]+$/.test(f))
}

/** Turn the raw heartbeat value (ms-epoch string or null) into a liveness verdict. */
export function computeLiveness(beatRaw: string | null, now: number): WorkerLiveness {
  if (!beatRaw) return { alive: false, lastBeatAgoMs: null }
  const beat = Number(beatRaw)
  if (!Number.isFinite(beat)) return { alive: false, lastBeatAgoMs: null }
  const ago = now - beat
  return { alive: ago <= HEARTBEAT_TTL_MS, lastBeatAgoMs: ago }
}
