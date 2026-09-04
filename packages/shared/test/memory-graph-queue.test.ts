import { describe, it, expect, vi, beforeEach } from 'vitest'

const ctorCalls = vi.hoisted(() => ({
  queue: [] as Array<{ name: string; opts: any }>,
  worker: [] as Array<{ name: string; processor: any; opts: any }>,
}))

vi.mock('bullmq', () => {
  class FakeQueue {
    added: Array<{ name: string; data: any; opts: any }> = []
    constructor(public name: string, public opts: any) {
      ctorCalls.queue.push({ name, opts })
    }
    async add(name: string, data: any, opts: any): Promise<{ id: string }> {
      this.added.push({ name, data, opts })
      return { id: opts?.jobId ?? 'auto-id' }
    }
  }
  class FakeWorker {
    constructor(public name: string, public processor: any, public opts: any) {
      ctorCalls.worker.push({ name, processor, opts })
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker }
})

import {
  MEMORY_GRAPH_REBUILD_QUEUE,
  enqueueMemoryGraphRebuild,
  makeMemoryGraphRebuildQueue,
  makeMemoryGraphRebuildWorker,
  memoryGraphEpisodeName,
  type MemoryGraphRebuildJobData,
} from '../src/queue/index.ts'

const CONN = { host: 'redis', port: 6379, maxRetriesPerRequest: null, enableReadyCheck: false } as const

const sampleJob = (): MemoryGraphRebuildJobData => ({
  jobId: 'job-1',
  requestedById: 'user-1',
  requestedAt: '2026-07-02T00:00:00.000Z',
  filters: { teamId: 'team-1', project: 'alpha', createdById: 'user-2' },
})

beforeEach(() => {
  ctorCalls.queue.length = 0
  ctorCalls.worker.length = 0
})

describe('memory graph rebuild queue', () => {
  it('uses a dedicated one-time queue name', () => {
    expect(MEMORY_GRAPH_REBUILD_QUEUE).toBe('pm.memory-graph-rebuild')
  })

  it('names memory episodes consistently as mem:<memoryId>', () => {
    expect(memoryGraphEpisodeName('abc-123')).toBe('mem:abc-123')
  })

  it('constructs the queue with bounded retention and no retry duplicates', () => {
    makeMemoryGraphRebuildQueue(CONN as any)
    expect(ctorCalls.queue).toHaveLength(1)
    expect(ctorCalls.queue[0]!.name).toBe(MEMORY_GRAPH_REBUILD_QUEUE)
    expect(ctorCalls.queue[0]!.opts.connection).toBe(CONN)
    expect(ctorCalls.queue[0]!.opts.defaultJobOptions.attempts).toBe(1)
    expect(ctorCalls.queue[0]!.opts.defaultJobOptions.removeOnComplete).toEqual({ age: 24 * 3600, count: 100 })
  })

  it('enqueues a one-time rebuild under a stable job id', async () => {
    const queue = makeMemoryGraphRebuildQueue(CONN as any)
    const data = sampleJob()
    const id = await enqueueMemoryGraphRebuild(queue as any, data)

    expect(id).toBe('job-1')
    expect((queue as any).added).toEqual([
      {
        name: 'memory-graph-rebuild',
        data,
        opts: { jobId: 'job-1' },
      },
    ])
  })

  it('constructs a low-concurrency worker for long Graphiti rebuilds', () => {
    const processor = vi.fn()
    makeMemoryGraphRebuildWorker(processor as any, { connection: CONN as any })

    expect(ctorCalls.worker).toHaveLength(1)
    expect(ctorCalls.worker[0]!.name).toBe(MEMORY_GRAPH_REBUILD_QUEUE)
    expect(ctorCalls.worker[0]!.processor).toBe(processor)
    expect(ctorCalls.worker[0]!.opts.concurrency).toBe(1)
    expect(ctorCalls.worker[0]!.opts.lockDuration).toBe(600_000)
  })
})
