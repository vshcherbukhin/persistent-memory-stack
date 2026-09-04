/** @pm/shared/queue — public surface of the BullMQ ingest contract. */
export { INGEST_QUEUE } from './types.ts'
export type { IngestJobData, IngestJobResult } from './types.ts'
export { makeIngestConnection } from './connection.ts'
export type { ConnectionOptions } from './connection.ts'
export { makeIngestQueue, enqueueIngest, Queue } from './queue.ts'
export { makeIngestWorker, Worker } from './worker.ts'
export type { IngestWorkerOpts, Processor, Job } from './worker.ts'

// ── Managed scheduled-worker subsystem (Phase 5) ──
export {
  SCHEDULED_QUEUE,
  WORKER_HEARTBEAT_KEY,
  SCHEDULED_JOB_CATALOG,
  RETIRED_SCHEDULED_JOB_NAMES,
  catalogMeta,
  makeScheduledQueue,
  makeScheduledWorker,
  upsertSchedule,
  removeSchedule,
  runScheduleNow,
  listSchedules,
} from './scheduled.ts'
export type {
  ScheduledJobData,
  ScheduledJobResult,
  ScheduledJobMeta,
  ScheduledWorkerOpts,
  ScheduleInfo,
} from './scheduled.ts'

// ── One-time Memory Tools graph rebuild queue ──
export {
  MEMORY_GRAPH_REBUILD_QUEUE,
  memoryGraphEpisodeName,
  makeMemoryGraphRebuildQueue,
  enqueueMemoryGraphRebuild,
  makeMemoryGraphRebuildWorker,
} from './memory-graph.ts'
export type {
  MemoryGraphRebuildFilters,
  MemoryGraphRebuildJobData,
  MemoryGraphRebuildJobResult,
  MemoryGraphRebuildWorkerOpts,
} from './memory-graph.ts'
