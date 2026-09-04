/**
 * persistent-memory-api — BullMQ ingest queue service (Phase 6, producer side).
 *
 * One Queue per process, built at boot from REDIS_URL. POST /ingest enqueues
 * jobs via enqueueIngest(); the worker consumes them. The connection options
 * carry the mandatory worker flags (set inside @pm/shared/queue).
 */
import { makeIngestQueue, makeIngestConnection, type IngestJobData } from '@pm/shared'
import type { Queue } from 'bullmq'
import { config } from '../config.ts'

export const ingestQueue: Queue<IngestJobData> = makeIngestQueue(
  makeIngestConnection(config.REDIS_URL),
)
