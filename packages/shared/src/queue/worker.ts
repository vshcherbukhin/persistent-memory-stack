/**
 * @pm/shared/queue — consumer factory (imported by worker/). The processor is
 * INJECTED by the worker package — shared stays free of @pm/db + the pipeline.
 */
import { Worker, type Processor, type ConnectionOptions, type Job } from 'bullmq'
import { INGEST_QUEUE, type IngestJobData, type IngestJobResult } from './types.ts'

export interface IngestWorkerOpts {
  connection: ConnectionOptions
  /** server-managed embed is CPU-bound (server Ollama on a no-GPU VM) → keep low (default 2). */
  concurrency?: number
  /** ms; a big-PDF embed can exceed the 30s default and trip the stalled-job checker. */
  lockDuration?: number
}

// Name generic left as the default `string`: pinning it to the 'ingest' literal
// makes the injected Processor's job-name type incompatible with BullMQ's own
// Worker signature (it widens the name to string internally).
export function makeIngestWorker(
  processor: Processor<IngestJobData, IngestJobResult>,
  opts: IngestWorkerOpts,
): Worker<IngestJobData, IngestJobResult> {
  return new Worker<IngestJobData, IngestJobResult>(INGEST_QUEUE, processor, {
    connection: opts.connection,
    concurrency: opts.concurrency ?? 2,
    lockDuration: opts.lockDuration ?? 120_000, // 2 min — heavy LLM/embed steps
  })
}

export { Worker }
export type { Processor, Job }
