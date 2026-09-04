/**
 * Unit: makeScheduledProcessor — the run lifecycle + telemetry transitions.
 *
 *   • success → status 'running' then 'success', errorCount reset to 0, lastError
 *     cleared, logTail = the handler summary; returns { summary }.
 *   • failure → status 'failed', errorCount incremented, lastError stamped, and the
 *     error is RE-THROWN (so BullMQ marks the job failed; attempts=1 → no retry).
 *   • unknown name → throws before any handler runs.
 *
 * ownerPrisma + the registry are mocked so this isolates the branching from Redis/DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job, ScheduledJobData, ScheduledJobResult } from '@pm/shared'

const { update, findUnique, run } = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
  findUnique: vi.fn(async () => ({ enabled: true }) as { enabled: boolean } | null),
  run: vi.fn<() => Promise<string>>(),
}))
vi.mock('@pm/db', () => ({ ownerPrisma: { scheduledJob: { update, findUnique } } }))
vi.mock('../src/scheduled/registry.ts', () => ({
  findHandler: (name: string) =>
    name === 'job-x' ? { name, description: 'x', defaultCron: '* * * * *', run } : undefined,
}))

import { makeScheduledProcessor } from '../src/scheduled/processor.ts'

const fakeJob = (name: string, manual = false): Job<ScheduledJobData, ScheduledJobResult> =>
  ({ data: { name, manual } }) as unknown as Job<ScheduledJobData, ScheduledJobResult>

beforeEach(() => {
  update.mockClear()
  findUnique.mockReset()
  findUnique.mockResolvedValue({ enabled: true })
  run.mockReset()
})

describe('makeScheduledProcessor', () => {
  it('on success stamps success telemetry and returns the summary', async () => {
    run.mockResolvedValue('did the thing (7 rows)')
    const proc = makeScheduledProcessor({} as never)
    const res = await proc(fakeJob('job-x'))

    expect(res).toEqual({ summary: 'did the thing (7 rows)' })
    // first update = running
    expect(update.mock.calls[0]![0]).toMatchObject({ where: { name: 'job-x' }, data: { status: 'running' } })
    // last update = success
    const success = update.mock.calls[update.mock.calls.length - 1]![0] as { data: Record<string, unknown> }
    expect(success.data).toMatchObject({
      status: 'success',
      logTail: 'did the thing (7 rows)',
      lastError: null,
      errorCount: 0,
    })
    expect(typeof success.data.lastDurationMs).toBe('number')
  })

  it('on failure stamps failed telemetry, increments errorCount, and re-throws', async () => {
    run.mockRejectedValue(new Error('boom'))
    const proc = makeScheduledProcessor({} as never)
    await expect(proc(fakeJob('job-x'))).rejects.toThrow('boom')

    const failed = update.mock.calls[update.mock.calls.length - 1]![0] as { data: Record<string, unknown> }
    expect(failed.data).toMatchObject({
      status: 'failed',
      lastError: 'boom',
      errorCount: { increment: 1 },
    })
  })

  it('throws for an unknown handler name (no telemetry write attempted)', async () => {
    const proc = makeScheduledProcessor({} as never)
    await expect(proc(fakeJob('nope'))).rejects.toThrow(/no scheduled handler/i)
    expect(update).not.toHaveBeenCalled()
  })

  it('SKIPS a disabled job on a scheduled (non-manual) tick — does not run the handler', async () => {
    findUnique.mockResolvedValue({ enabled: false })
    const proc = makeScheduledProcessor({} as never)
    const res = await proc(fakeJob('job-x', false))
    expect(res.summary).toMatch(/disabled/i)
    expect(run).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled() // no telemetry churn for a skipped tick
  })

  it('a MANUAL run-now runs even when the job is disabled', async () => {
    findUnique.mockResolvedValue({ enabled: false })
    run.mockResolvedValue('ran manually')
    const proc = makeScheduledProcessor({} as never)
    const res = await proc(fakeJob('job-x', true))
    expect(res.summary).toBe('ran manually')
    expect(run).toHaveBeenCalledOnce()
  })
})
