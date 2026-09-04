/**
 * @pm/shared/queue — producer side (imported by the api). One Queue per process;
 * the api builds it at boot and calls enqueueIngest() from POST /ingest.
 */
import { Queue, type ConnectionOptions } from 'bullmq'
import { INGEST_QUEUE, type IngestJobData } from './types.ts'

export function makeIngestQueue(connection: ConnectionOptions): Queue<IngestJobData> {
  return new Queue<IngestJobData>(INGEST_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: 'exponential', delay: 5_000 }, // 5s, 10s, 20s, 40s
      removeOnComplete: { age: 3600, count: 1000 }, // keep recent for debugging
      removeOnFail: { age: 24 * 3600 }, // keep failures a day
    },
  })
}

/**
 * jobId === ingestJobId is the idempotency key: a duplicate enqueue for the same
 * IngestJob row is collapsed by BullMQ (Redis dedupes on jobId). Returns the
 * Bull job id (== ingestJobId).
 */
export async function enqueueIngest(
  queue: Queue<IngestJobData>,
  data: IngestJobData,
): Promise<string> {
  const job = await queue.add('ingest', data, { jobId: data.ingestJobId })
  return job.id!
}

export { Queue }
