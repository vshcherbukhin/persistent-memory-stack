/**
 * BullMQ ingest contract — job-type / queue / worker wiring.
 *
 * No live Redis: we mock the `bullmq` module so `new Queue(...)` / `new Worker(...)`
 * are captured-args fakes. That lets us assert the wiring the producer + consumer
 * factories set up — queue name, default job options, the idempotency jobId, the
 * job NAME ('ingest'), and the worker's mandatory concurrency / lockDuration
 * defaults — without touching the network. `enqueueIngest` is also driven against
 * a hand fake to assert jobId === ingestJobId (the dedupe key) and the return.
 *
 * Covered:
 *   • INGEST_QUEUE constant value ('pm.ingest').
 *   • makeIngestQueue passes the queue name + connection + the retry/backoff/
 *     retention defaults verbatim.
 *   • enqueueIngest adds job NAME 'ingest', sets jobId === data.ingestJobId
 *     (BullMQ dedupe), and returns the resulting job id.
 *   • makeIngestConnection parses a redis:// URL into host/port/user/pass and
 *     sets the two mandatory worker flags; throws when the URL is missing.
 *   • makeIngestWorker wires queue name + injected processor + concurrency /
 *     lockDuration defaults, and honors overrides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock bullmq: capture constructor args for Queue + Worker. ────────────────
const ctorCalls = vi.hoisted(() => ({
  queue: [] as Array<{ name: string; opts: any }>,
  worker: [] as Array<{ name: string; processor: any; opts: any }>,
}))

vi.mock('bullmq', () => {
  class FakeQueue {
    name: string
    opts: any
    added: Array<{ name: string; data: any; opts: any }> = []
    constructor(name: string, opts: any) {
      this.name = name
      this.opts = opts
      ctorCalls.queue.push({ name, opts })
    }
    async add(name: string, data: any, opts: any): Promise<{ id: string }> {
      this.added.push({ name, data, opts })
      // Mirror BullMQ: the explicit jobId becomes the job's id.
      return { id: opts?.jobId ?? 'auto-generated-id' }
    }
  }
  class FakeWorker {
    name: string
    processor: any
    opts: any
    constructor(name: string, processor: any, opts: any) {
      this.name = name
      this.processor = processor
      this.opts = opts
      ctorCalls.worker.push({ name, processor, opts })
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker }
})

import { INGEST_QUEUE } from '../src/queue/types.ts'
import type { IngestJobData } from '../src/queue/types.ts'
import { makeIngestQueue, enqueueIngest } from '../src/queue/queue.ts'
import { makeIngestConnection } from '../src/queue/connection.ts'
import { makeIngestWorker } from '../src/queue/worker.ts'

const CONN = { host: 'r', port: 6379, maxRetriesPerRequest: null, enableReadyCheck: false } as const

const sampleData = (): IngestJobData => ({
  ingestJobId: 'job-uuid-123',
  sourceId: 'src-uuid',
  documentId: 'doc-uuid',
  teamId: 'team-uuid',
  project: 'general',
  minioObjectKey: 'team/team-uuid/general/src-uuid/original/file.pdf',
  mimeType: 'application/pdf',
  filename: 'file.pdf',
  sessionId: null,
})

beforeEach(() => {
  ctorCalls.queue.length = 0
  ctorCalls.worker.length = 0
})

describe('INGEST_QUEUE constant', () => {
  it('is the single-sourced queue name pm.ingest', () => {
    expect(INGEST_QUEUE).toBe('pm.ingest')
  })
})

describe('makeIngestQueue — producer wiring', () => {
  it('constructs the Queue with the canonical name + injected connection', () => {
    makeIngestQueue(CONN as any)
    expect(ctorCalls.queue).toHaveLength(1)
    expect(ctorCalls.queue[0]!.name).toBe(INGEST_QUEUE)
    expect(ctorCalls.queue[0]!.opts.connection).toBe(CONN)
  })

  it('sets the retry / backoff / retention defaults verbatim', () => {
    makeIngestQueue(CONN as any)
    const djo = ctorCalls.queue[0]!.opts.defaultJobOptions
    expect(djo.attempts).toBe(4)
    expect(djo.backoff).toEqual({ type: 'exponential', delay: 5_000 })
    expect(djo.removeOnComplete).toEqual({ age: 3600, count: 1000 })
    expect(djo.removeOnFail).toEqual({ age: 24 * 3600 })
  })
})

describe('enqueueIngest — job type + idempotency', () => {
  it('adds the job under name "ingest" with jobId === ingestJobId', async () => {
    const queue = makeIngestQueue(CONN as any)
    const data = sampleData()
    const id = await enqueueIngest(queue as any, data)

    const added = (queue as any).added as Array<{ name: string; data: any; opts: any }>
    expect(added).toHaveLength(1)
    expect(added[0]!.name).toBe('ingest')
    expect(added[0]!.data).toBe(data)
    // The dedupe key: BullMQ collapses a re-enqueue for the same IngestJob row.
    expect(added[0]!.opts.jobId).toBe('job-uuid-123')
    // Returns the resulting job id (== ingestJobId in BullMQ).
    expect(id).toBe('job-uuid-123')
  })

  it('a re-enqueue uses the same jobId (collapses to the same row)', async () => {
    const queue = makeIngestQueue(CONN as any)
    const data = sampleData()
    const id1 = await enqueueIngest(queue as any, data)
    const id2 = await enqueueIngest(queue as any, data)
    expect(id1).toBe(id2)
    const added = (queue as any).added as Array<{ opts: any }>
    expect(added[0]!.opts.jobId).toBe(added[1]!.opts.jobId)
  })
})

describe('makeIngestConnection — redis URL parsing + mandatory flags', () => {
  it('parses host/port/username/password from a redis:// URL', () => {
    const c = makeIngestConnection('redis://user:pass@redishost:6380') as any
    expect(c.host).toBe('redishost')
    expect(c.port).toBe(6380)
    expect(c.username).toBe('user')
    expect(c.password).toBe('pass')
  })

  it('defaults the port to 6379 and leaves creds undefined when absent', () => {
    const c = makeIngestConnection('redis://plainhost') as any
    expect(c.port).toBe(6379)
    expect(c.username).toBeUndefined()
    expect(c.password).toBeUndefined()
  })

  it('sets the two mandatory BullMQ worker flags', () => {
    const c = makeIngestConnection('redis://h:6379') as any
    expect(c.maxRetriesPerRequest).toBeNull()
    expect(c.enableReadyCheck).toBe(false)
  })

  it('throws when no redis URL is provided', () => {
    expect(() => makeIngestConnection(undefined)).toThrow(/REDIS_URL/)
  })
})

describe('makeIngestWorker — consumer wiring', () => {
  it('constructs the Worker with the queue name, injected processor, and defaults', () => {
    const processor = vi.fn()
    makeIngestWorker(processor as any, { connection: CONN as any })
    expect(ctorCalls.worker).toHaveLength(1)
    const call = ctorCalls.worker[0]!
    expect(call.name).toBe(INGEST_QUEUE)
    expect(call.processor).toBe(processor)
    expect(call.opts.connection).toBe(CONN)
    expect(call.opts.concurrency).toBe(2) // CPU-bound embed default
    expect(call.opts.lockDuration).toBe(120_000) // 2 min for heavy steps
  })

  it('honors concurrency + lockDuration overrides', () => {
    const processor = vi.fn()
    makeIngestWorker(processor as any, { connection: CONN as any, concurrency: 5, lockDuration: 30_000 })
    const call = ctorCalls.worker[0]!
    expect(call.opts.concurrency).toBe(5)
    expect(call.opts.lockDuration).toBe(30_000)
  })
})
