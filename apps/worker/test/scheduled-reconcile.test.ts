/**
 * Unit: planReconcile — the pure decision that maps (code handlers + ScheduledJob
 * rows) → the schedule actions to apply (create missing rows, upsert schedulers
 * for enabled jobs, remove schedulers for disabled jobs). The DB/Redis effects are
 * applied by reconcileSchedules(); this isolates the branching logic.
 */
import { describe, it, expect } from 'vitest'
import { planReconcile, type ScheduleRow } from '../src/scheduled/reconcile.ts'
import type { ScheduledHandler } from '../src/scheduled/registry.ts'

const handler = (name: string, defaultCron: string): ScheduledHandler => ({
  name,
  description: `${name} desc`,
  defaultCron,
  run: async () => 'ok',
})

describe('planReconcile', () => {
  it('creates a row AND upserts a scheduler for a handler with no row', () => {
    const plan = planReconcile([handler('usage-sweep', '0 3 * * *')], [])
    expect(plan.toCreate).toEqual([{ name: 'usage-sweep', cron: '0 3 * * *' }])
    expect(plan.toUpsertSchedule).toEqual([{ name: 'usage-sweep', cron: '0 3 * * *' }])
    expect(plan.toRemoveSchedule).toEqual([])
  })

  it('upserts a scheduler at the ROW cron (not the default) for an existing enabled row', () => {
    const rows: ScheduleRow[] = [{ name: 'usage-sweep', cron: '0 4 * * *', enabled: true }]
    const plan = planReconcile([handler('usage-sweep', '0 3 * * *')], rows)
    expect(plan.toCreate).toEqual([])
    expect(plan.toUpsertSchedule).toEqual([{ name: 'usage-sweep', cron: '0 4 * * *' }])
    expect(plan.toRemoveSchedule).toEqual([])
  })

  it('removes the scheduler for an existing disabled row', () => {
    const rows: ScheduleRow[] = [{ name: 'usage-sweep', cron: '0 3 * * *', enabled: false }]
    const plan = planReconcile([handler('usage-sweep', '0 3 * * *')], rows)
    expect(plan.toCreate).toEqual([])
    expect(plan.toUpsertSchedule).toEqual([])
    expect(plan.toRemoveSchedule).toEqual(['usage-sweep'])
  })

  it('removes the retired archive scheduler and durable row during update', () => {
    const rows: ScheduleRow[] = [{ name: 'memory-archive', cron: '0 4 * * *', enabled: true }]
    const plan = planReconcile([handler('usage-sweep', '0 3 * * *')], rows, ['memory-archive'])
    expect(plan.toCreate).toEqual([{ name: 'usage-sweep', cron: '0 3 * * *' }])
    expect(plan.toUpsertSchedule).toEqual([{ name: 'usage-sweep', cron: '0 3 * * *' }])
    expect(plan.toRemoveSchedule).toEqual(['memory-archive'])
    expect(plan.toDeleteRows).toEqual(['memory-archive'])
  })

  it('handles a mix across several handlers in one pass', () => {
    const handlers = [
      handler('a', '0 1 * * *'),
      handler('b', '0 2 * * *'),
      handler('c', '0 3 * * *'),
    ]
    const rows: ScheduleRow[] = [
      { name: 'a', cron: '0 9 * * *', enabled: true }, // edited cron, enabled → upsert at 0 9
      { name: 'b', cron: '0 2 * * *', enabled: false }, // disabled → remove
      // c has no row → create + upsert at default
    ]
    const plan = planReconcile(handlers, rows)
    expect(plan.toCreate).toEqual([{ name: 'c', cron: '0 3 * * *' }])
    expect(plan.toUpsertSchedule).toEqual([
      { name: 'a', cron: '0 9 * * *' },
      { name: 'c', cron: '0 3 * * *' },
    ])
    expect(plan.toRemoveSchedule).toEqual(['b'])
  })
})
