/**
 * worker/scheduled — reconcile the BullMQ job-schedulers to the ScheduledJob rows.
 *
 * The ScheduledJob table is the DURABLE source of truth for the schedule (cron +
 * enabled); BullMQ schedulers in Redis drive the ticks. planReconcile() is the
 * pure decision (unit-tested); reconcileSchedules() applies it: insert missing
 * rows (default cron, enabled), upsert a scheduler for every enabled job at its
 * row's cron, remove the scheduler for every disabled job. Runs on worker boot so
 * the schedule exists even if the dashboard never touched it.
 */
import type { Queue } from 'bullmq'
import { ownerPrisma } from '@pm/db'
import {
  RETIRED_SCHEDULED_JOB_NAMES,
  upsertSchedule,
  removeSchedule,
  type ScheduledJobData,
} from '@pm/shared'
import type { ScheduledHandler } from './registry.ts'

/** The subset of a ScheduledJob row the reconcile decision needs. */
export interface ScheduleRow {
  name: string
  cron: string
  enabled: boolean
}

export interface ReconcilePlan {
  /** Handlers with no row yet — insert at the handler's default cron (enabled). */
  toCreate: { name: string; cron: string }[]
  /** Jobs that should have a live scheduler, at this cron. */
  toUpsertSchedule: { name: string; cron: string }[]
  /** Jobs whose scheduler must NOT exist (disabled rows). */
  toRemoveSchedule: string[]
  /** Retired product jobs whose durable schedule rows must be removed. */
  toDeleteRows: string[]
}

/**
 * Pure: given the code handlers and the current rows, decide the actions. Iterates
 * the handlers (the code-defined set): a handler with no row → create + upsert at
 * default; an enabled row → upsert at the ROW's cron (honours dashboard edits); a
 * disabled row → remove. Stale rows (no handler) are ignored.
 */
export function planReconcile(
  handlers: ScheduledHandler[],
  rows: ScheduleRow[],
  retiredNames: readonly string[] = RETIRED_SCHEDULED_JOB_NAMES,
): ReconcilePlan {
  const plan: ReconcilePlan = { toCreate: [], toUpsertSchedule: [], toRemoveSchedule: [], toDeleteRows: [] }
  for (const h of handlers) {
    const row = rows.find((r) => r.name === h.name)
    if (!row) {
      plan.toCreate.push({ name: h.name, cron: h.defaultCron })
      plan.toUpsertSchedule.push({ name: h.name, cron: h.defaultCron })
    } else if (row.enabled) {
      plan.toUpsertSchedule.push({ name: h.name, cron: row.cron })
    } else {
      plan.toRemoveSchedule.push(h.name)
    }
  }
  for (const name of retiredNames) {
    if (rows.some((row) => row.name === name)) {
      plan.toRemoveSchedule.push(name)
      plan.toDeleteRows.push(name)
    }
  }
  return plan
}

export async function reconcileSchedules(
  queue: Queue<ScheduledJobData>,
  handlers: ScheduledHandler[],
): Promise<void> {
  const existing = await ownerPrisma.scheduledJob.findMany({
    select: { name: true, cron: true, enabled: true },
  })
  const plan = planReconcile(handlers, existing)

  for (const c of plan.toCreate) {
    // skipDuplicates: another worker replica may race the same first insert.
    await ownerPrisma.scheduledJob.createMany({
      data: [{ name: c.name, cron: c.cron }],
      skipDuplicates: true,
    })
  }
  for (const u of plan.toUpsertSchedule) await upsertSchedule(queue, u.name, u.cron)
  for (const name of plan.toRemoveSchedule) await removeSchedule(queue, name)
  if (plan.toDeleteRows.length > 0) {
    await ownerPrisma.scheduledJob.deleteMany({ where: { name: { in: plan.toDeleteRows } } })
  }
  // ponytail: a dashboard mutation racing this boot read could leave a stray
  // scheduler (e.g. reconcile re-adds one the dashboard just paused). That's benign:
  // the processor reads `enabled` from the row and SKIPS a disabled job's tick, so
  // the row stays authoritative. No SELECT…FOR UPDATE / per-op refetch needed.
}
