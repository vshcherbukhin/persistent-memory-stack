import { describe, expect, it } from 'vitest'
import { buildSchedulePreview, cronDescription, draftFromWorker } from './worker-schedule'
import type { WorkerStatus } from './types'

function worker(cron: string): WorkerStatus {
  return {
    name: 'graph-lifecycle',
    description: 'test',
    cron,
    enabled: true,
    status: 'success',
    lastRunAt: null,
    lastFinishAt: null,
    lastDurationMs: null,
    lastError: null,
    logTail: null,
    errorCount: 0,
    nextRunAt: null,
  }
}

describe('worker schedule cadence presentation', () => {
  it('describes a step schedule without expanding it into every minute', () => {
    expect(cronDescription('*/2 * * * *', true)).toBe('Every 2 minutes')
    expect(cronDescription('*/1 * * * *', true)).toBe('Every minute')
    expect(cronDescription('*/5 * * * *', true)).toBe('Every 5 minutes')
  })

  it('round-trips a two-minute hourly schedule without changing its cron', () => {
    const draft = draftFromWorker(worker('*/2 * * * *'))

    expect(draft).toMatchObject({ mode: 'hourly', hourlyCadence: 'interval', interval: '2' })
    expect(buildSchedulePreview(draft, '*/2 * * * *')).toMatchObject({
      cron: '*/2 * * * *',
      text: 'Every 2 minutes',
      valid: true,
    })
  })

  it('keeps explicit minute lists as a distinct hourly schedule', () => {
    const draft = draftFromWorker(worker('0,15,30,45 * * * *'))

    expect(draft.hourlyCadence).toBe('minutes')
    expect(buildSchedulePreview(draft, '0,15,30,45 * * * *')).toMatchObject({
      cron: '0,15,30,45 * * * *',
      text: 'At minutes 00, 15, 30, 45 of every hour',
    })
  })
})
