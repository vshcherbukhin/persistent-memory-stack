/**
 * @pm/shared/queue — one-time Memory → Graphiti rebuild jobs.
 *
 * This is intentionally NOT part of the managed scheduled-worker catalog. It backs
 * a dashboard Memory Tool that queues an operator-triggered, filtered replay of
 * existing Memory rows through the Graphiti episode flow.
 */
import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq'

export const MEMORY_GRAPH_REBUILD_QUEUE = 'pm.memory-graph-rebuild' as const

export interface MemoryGraphRebuildFilters {
  teamId?: string
  project?: string
  createdById?: string
}

export interface MemoryGraphRebuildJobData {
  jobId: string
  requestedById: string
  requestedAt: string
  filters: MemoryGraphRebuildFilters
}

export interface MemoryGraphRebuildJobResult {
  scanned: number
  rebuilt: number
  failed: number
  deletedEpisodes: number
  summary: string
}

export interface MemoryGraphRebuildWorkerOpts {
  connection: ConnectionOptions
  concurrency?: number
  lockDuration?: number
}

export function memoryGraphEpisodeName(memoryId: string): string {
  return `mem:${memoryId}`
}

export function makeMemoryGraphRebuildQueue(
  connection: ConnectionOptions,
): Queue<MemoryGraphRebuildJobData> {
  return new Queue<MemoryGraphRebuildJobData>(MEMORY_GRAPH_REBUILD_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 100 },
      removeOnFail: { age: 7 * 24 * 3600, count: 100 },
    },
  })
}

export async function enqueueMemoryGraphRebuild(
  queue: Queue<MemoryGraphRebuildJobData>,
  data: MemoryGraphRebuildJobData,
): Promise<string> {
  const job = await queue.add('memory-graph-rebuild', data, { jobId: data.jobId })
  return job.id!
}

export function makeMemoryGraphRebuildWorker(
  processor: Processor<MemoryGraphRebuildJobData, MemoryGraphRebuildJobResult>,
  opts: MemoryGraphRebuildWorkerOpts,
): Worker<MemoryGraphRebuildJobData, MemoryGraphRebuildJobResult> {
  return new Worker<MemoryGraphRebuildJobData, MemoryGraphRebuildJobResult>(
    MEMORY_GRAPH_REBUILD_QUEUE,
    processor,
    {
      connection: opts.connection,
      concurrency: opts.concurrency ?? 1,
      lockDuration: opts.lockDuration ?? 600_000,
    },
  )
}
