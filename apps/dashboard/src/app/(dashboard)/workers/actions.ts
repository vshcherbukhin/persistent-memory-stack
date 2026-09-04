'use server'

import { api, ApiError } from '@/lib/api'
import { requireSession, requireControlPlane, isSuperuser } from '@/lib/session'
import type { WorkerStatus, WorkerLiveness, WorkerLog, WorkerAction } from '@/lib/types'

/**
 * Workers-monitor actions. Listing + logs are viewable by ANY authenticated user
 * (the API gates these reads at requireSession, not admin+); pause/resume/run-now
 * and schedule edits are superuser-only (they change what runs on the server — the
 * API also enforces requireSuperuser). All return readable errors.
 */
export async function listWorkersAction(): Promise<{
  workers: WorkerStatus[]
  liveness: WorkerLiveness | null
  error?: string
}> {
  await requireSession()
  try {
    const r = await api.listWorkers()
    return { workers: r.workers, liveness: r.liveness }
  } catch (err) {
    if (err instanceof ApiError) return { workers: [], liveness: null, error: err.message }
    throw err
  }
}

export async function workerLogsAction(name: string): Promise<{ log: WorkerLog | null; error?: string }> {
  await requireSession()
  try {
    return { log: await api.workerLogs(name) }
  } catch (err) {
    if (err instanceof ApiError) return { log: null, error: err.message }
    throw err
  }
}

export async function workerActionAction(
  name: string,
  action: WorkerAction,
): Promise<{ ok: boolean; error?: string }> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { ok: false, error: 'Only a superuser may control scheduled jobs.' }
  try {
    await api.workerAction(name, action)
    return { ok: true }
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message }
    throw err
  }
}

export async function editWorkerAction(
  name: string,
  body: { cron?: string; enabled?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { ok: false, error: 'Only a superuser may edit a schedule.' }
  try {
    await api.editWorker(name, body)
    return { ok: true }
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message }
    throw err
  }
}
