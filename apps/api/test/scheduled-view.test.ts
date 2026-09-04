/**
 * Unit: the pure view-builders for the Workers control plane.
 *   • buildWorkerView — merges ScheduledJob rows + live BullMQ schedulers + the
 *     job catalog into the dashboard WorkerStatus[] (ISO times, next-run only when
 *     enabled, description from the catalog with a name fallback).
 *   • computeLiveness — turns the raw heartbeat value into {alive, lastBeatAgoMs}.
 * No Redis / DB — these are the testable core of services/scheduled.ts.
 */
import { describe, it, expect } from 'vitest'
import { buildWorkerView, computeLiveness, isPlausibleCron, type ScheduledRow } from '../src/services/scheduled-view.ts'
import type { ScheduleInfo, ScheduledJobMeta } from '@pm/shared'

const CATALOG: readonly ScheduledJobMeta[] = [
  { name: 'usage-sweep', description: 'Sweep old usage rollups.', defaultCron: '0 3 * * *' },
]

const row = (over: Partial<ScheduledRow> = {}): ScheduledRow => ({
  name: 'usage-sweep',
  cron: '0 3 * * *',
  enabled: true,
  status: 'success',
  lastRunAt: new Date('2026-06-27T03:00:00.000Z'),
  lastFinishAt: new Date('2026-06-27T03:00:01.000Z'),
  lastDurationMs: 1000,
  lastError: null,
  logTail: 'deleted 0 usage rollup row(s) older than 90d',
  errorCount: 0,
  ...over,
})

describe('buildWorkerView', () => {
  it('merges row + catalog description + live next-run for an enabled job', () => {
    const sched: ScheduleInfo[] = [
      { name: 'usage-sweep', pattern: '0 3 * * *', next: Date.parse('2026-06-28T03:00:00.000Z') },
    ]
    const [w] = buildWorkerView([row()], sched, CATALOG)
    expect(w).toMatchObject({
      name: 'usage-sweep',
      description: 'Sweep old usage rollups.',
      cron: '0 3 * * *',
      enabled: true,
      status: 'success',
      lastRunAt: '2026-06-27T03:00:00.000Z',
      lastFinishAt: '2026-06-27T03:00:01.000Z',
      lastDurationMs: 1000,
      lastError: null,
      logTail: 'deleted 0 usage rollup row(s) older than 90d',
      errorCount: 0,
      nextRunAt: '2026-06-28T03:00:00.000Z',
    })
  })

  it('reports no next-run for a disabled job even if a stale scheduler is present', () => {
    const sched: ScheduleInfo[] = [{ name: 'usage-sweep', pattern: '0 3 * * *', next: Date.now() + 1000 }]
    const [w] = buildWorkerView([row({ enabled: false })], sched, CATALOG)
    expect(w.enabled).toBe(false)
    expect(w.nextRunAt).toBeNull()
  })

  it('passes null timestamps through and falls back to the name when not in the catalog', () => {
    const [w] = buildWorkerView(
      [row({ name: 'mystery', status: 'idle', lastRunAt: null, lastFinishAt: null, lastDurationMs: null })],
      [],
      CATALOG,
    )
    expect(w).toMatchObject({
      name: 'mystery',
      description: 'mystery',
      lastRunAt: null,
      lastFinishAt: null,
      lastDurationMs: null,
      nextRunAt: null,
    })
  })
})

describe('computeLiveness', () => {
  const now = Date.parse('2026-06-27T12:00:00.000Z')
  it('alive when the last beat is within 60s', () => {
    expect(computeLiveness(String(now - 5_000), now)).toEqual({ alive: true, lastBeatAgoMs: 5_000 })
  })
  it('not alive when the last beat is older than 60s', () => {
    expect(computeLiveness(String(now - 90_000), now)).toEqual({ alive: false, lastBeatAgoMs: 90_000 })
  })
  it('not alive when there is no beat', () => {
    expect(computeLiveness(null, now)).toEqual({ alive: false, lastBeatAgoMs: null })
  })
})

describe('isPlausibleCron', () => {
  it('accepts standard 5-field and 6-field (seconds) patterns', () => {
    expect(isPlausibleCron('0 3 * * *')).toBe(true)
    expect(isPlausibleCron('*/15 * * * *')).toBe(true)
    expect(isPlausibleCron('0 0 1,15 * *')).toBe(true)
    expect(isPlausibleCron('30 0 3 * * *')).toBe(true) // 6-field with seconds
  })
  it('rejects wrong field counts and junk', () => {
    expect(isPlausibleCron('')).toBe(false)
    expect(isPlausibleCron('0 3 * *')).toBe(false) // 4 fields
    expect(isPlausibleCron('not a cron')).toBe(false)
    expect(isPlausibleCron('0 3 * * * * *')).toBe(false) // 7 fields
    expect(isPlausibleCron('@daily')).toBe(false) // macros not supported by BullMQ
  })
})
