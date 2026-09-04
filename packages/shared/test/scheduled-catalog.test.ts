import { describe, expect, it } from 'vitest'
import { SCHEDULED_JOB_CATALOG } from '../src/queue/index.ts'

describe('SCHEDULED_JOB_CATALOG', () => {
  it('does not schedule automatic memory archival', () => {
    expect(SCHEDULED_JOB_CATALOG.some((job) => job.name === 'memory-archive')).toBe(false)
  })

  it('includes a managed graph retry job distinct from the one-time rebuild queue', () => {
    const graphJob = SCHEDULED_JOB_CATALOG.find((job) => job.name === 'memory-graph-backfill')

    expect(graphJob).toMatchObject({
      name: 'memory-graph-backfill',
      defaultCron: '*/15 * * * *',
    })
    expect(graphJob?.description).toMatch(/pending\/failed/i)
  })
})
