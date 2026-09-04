/**
 * persistent-memory-worker — entrypoint (Phase 6).
 *
 * Boot: initDb (the @pm/db clients), build the Qdrant/MinIO clients + (Mode A)
 * the server embedder, ensure the collection + bucket, then start the BullMQ
 * ingest Worker with the 7-step processor. A Redis heartbeat key (refreshed each
 * tick) backs the compose healthcheck. SIGTERM/SIGINT drain in-flight jobs.
 */
import 'dotenv/config'
import { Redis } from 'ioredis'
import {
  ensureCollection,
  makeActivePin,
  makeQdrantClient,
  resolveQdrantConfig,
  resolveEmbedConfig,
  makeEmbedderFromEnv,
  makeEmbedderForPin,
  makeMinioClient,
  resolveMinioConfig,
  ensureBucket,
  makeIngestConnection,
  makeIngestQueue,
  makeIngestWorker,
  makeMemoryGraphRebuildQueue,
  makeMemoryGraphRebuildWorker,
  makeScheduledQueue,
  makeScheduledWorker,
  setEmbedUsageSink,
  WORKER_HEARTBEAT_KEY,
  type Embedder,
} from '@pm/shared'
import { makeDlpClient, resolvePiiEntities } from '@pm/security-dlp'
import { initDb, ownerPrisma, recordUsageFireAndForget } from '@pm/db'
import { config } from './config.ts'
import { makeIngestProcessor } from './pipeline.ts'
import { makeMemoryGraphRebuildProcessor } from './memory-graph-processor.ts'
import { makeScheduledProcessor } from './scheduled/processor.ts'
import { reconcileSchedules } from './scheduled/reconcile.ts'
import { SCHEDULED_HANDLERS } from './scheduled/registry.ts'
import type { WorkerDeps } from './deps.ts'

async function main(): Promise<void> {
  // @pm/db clients — built before any runInTenant runs.
  initDb({ databaseUrl: config.DATABASE_URL, databaseMigrateUrl: config.DATABASE_MIGRATE_URL })

  // Record ingest-pipeline embedding usage (service='embeddings'). recordUsage
  // reads ownerPrisma at call time, so wiring the sink right after initDb is safe.
  setEmbedUsageSink((e) =>
    recordUsageFireAndForget({ service: 'embeddings', model: e.model, tokensIn: e.tokens, tokensOut: 0 }),
  )

  // Embedding pin — always derived from EMBED_* (Mode A embeds; Mode B matches).
  const embedCfg = resolveEmbedConfig()
  const pin = makeActivePin(embedCfg.model, embedCfg.dim)

  // Qdrant + MinIO clients.
  const qdrant = makeQdrantClient(resolveQdrantConfig())
  const minio = makeMinioClient(resolveMinioConfig())
  await ensureBucket(minio)

  // Mode A builds the server embedder + ensures the collection's active vector.
  // Mode B builds NO embedder — the embed step is never reached.
  const embedder: Embedder | null = config.EMBEDDING_MODE === 'server' ? makeEmbedderFromEnv() : null
  if (embedder) {
    try {
      await ensureCollection(qdrant, pin)
    } catch (err) {
      console.warn('WARN: [worker] ensureCollection failed at boot — will surface on first embed:', err)
    }
  }

  // One Redis connection shared by the ingest worker, the producer queue (the
  // reconciler re-enqueues onto it), and the scheduled subsystem.
  const connection = makeIngestConnection(config.REDIS_URL)
  const ingestQueue = makeIngestQueue(connection)

  const deps: WorkerDeps = {
    qdrant,
    embedder,
    pin,
    minio,
    embeddingMode: config.EMBEDDING_MODE,
    ingestQueue,
    dlpClient: makeDlpClient({ baseUrl: config.DLP_URL, timeoutMs: config.DLP_TIMEOUT_MS }),
    piiEntities: resolvePiiEntities(config.PII_ENTITIES),
    piiScoreThreshold: config.PII_SCORE_THRESHOLD,
    piiIngestGateEnabled: config.PII_INGEST_GATE_ENABLED,
    graphitiUrl: config.GRAPHITI_URL,
    graphitiTimeoutMs: config.GRAPHITI_TIMEOUT_MS,
    chunkMaxTokens: config.CHUNK_MAX_TOKENS,
    chunkOverlapTokens: config.CHUNK_OVERLAP_TOKENS,
    maxFileBytes: config.INGEST_MAX_FILE_BYTES,
  }

  const worker = makeIngestWorker(makeIngestProcessor(deps), {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
  })
  const memoryGraphRebuildQueue = makeMemoryGraphRebuildQueue(connection)
  const memoryGraphRebuildWorker = makeMemoryGraphRebuildWorker(makeMemoryGraphRebuildProcessor(deps), {
    connection,
  })

  worker.on('failed', (job, err) => {
    console.error(`ERROR: [ingest] job ${job?.id} failed:`, err?.message)
  })
  worker.on('completed', (job) => {
    console.log(`[ingest] job ${job.id} completed`)
  })
  memoryGraphRebuildWorker.on('failed', (job, err) => {
    console.error(`ERROR: [memory-graph-rebuild] job ${job?.id} failed:`, err?.message)
  })
  memoryGraphRebuildWorker.on('completed', (job) => {
    console.log(`[memory-graph-rebuild] job ${job.id} completed`)
  })

  // Heartbeat — a Redis key refreshed each tick; the compose healthcheck probes
  // it AND the dashboard Workers page reads it for worker liveness. It stays a
  // plain setInterval (NOT a scheduled job): it is process-liveness, not a business
  // schedule — routing a 15s probe through the job queue would make it falsely
  // "unhealthy" under queue backpressure and is a pause-footgun.
  const hb = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })
  const beat = setInterval(() => {
    void hb.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 60)
  }, 15_000)
  void hb.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 60)

  // Live embedding-pin refresh (Phase 10, #5) — the api drives a model switch and
  // flips the DB pin; this worker (a separate process) polls SystemSettings and
  // rebuilds its embedder so freshly-ingested chunks embed with the NEW pinned
  // model — no restart. Mutates the `deps` object (the steps read deps.pin/embedder
  // at call time). Mode A only. The api's post-flip pass-2 backfill reconciles the
  // brief poll-lag window. ponytail: 10s poll — a pub/sub push is the upgrade path.
  const refreshPin = async (): Promise<void> => {
    try {
      const row = await ownerPrisma.systemSettings.findUnique({
        where: { id: 'singleton' },
        select: { activeEmbedModel: true, activeEmbedDim: true },
      })
      if (!row || (row.activeEmbedModel === deps.pin.modelId && row.activeEmbedDim === deps.pin.dim)) return
      deps.pin = makeActivePin(row.activeEmbedModel, row.activeEmbedDim)
      if (config.EMBEDDING_MODE === 'server') deps.embedder = makeEmbedderForPin(row.activeEmbedModel, row.activeEmbedDim)
      console.log(`[worker] embedding pin refreshed → ${deps.pin.modelId}@${deps.pin.dim}`)
    } catch (err) {
      console.warn('WARN: [worker] pin refresh failed (will retry):', err instanceof Error ? err.message : err)
    }
  }
  const pinPoll = setInterval(() => void refreshPin(), 10_000)

  // Managed scheduled-worker subsystem (Phase 5) — a second BullMQ queue driven by
  // job-schedulers, reconciled to the ScheduledJob control table on boot. The
  // usage-rollup retention sweep (formerly a raw setInterval here) now runs as the
  // 'usage-sweep' scheduled job; the dashboard Workers page manages it.
  const scheduledQueue = makeScheduledQueue(connection)
  const scheduledWorker = makeScheduledWorker(makeScheduledProcessor(deps), { connection })
  scheduledWorker.on('failed', (job, err) => {
    console.error(`ERROR: [scheduled] job ${job?.data?.name ?? job?.id} failed:`, err?.message)
  })
  scheduledWorker.on('completed', (job) => {
    console.log(`[scheduled] job ${job.data.name} completed`)
  })
  try {
    await reconcileSchedules(scheduledQueue, SCHEDULED_HANDLERS)
  } catch (err) {
    console.warn('WARN: [scheduled] reconcile failed at boot — schedules may be stale:', err)
  }

  // Graceful shutdown: stop taking new jobs, finish active ones.
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[worker] ${sig} → draining…`)
    clearInterval(beat)
    clearInterval(pinPoll)
    await Promise.all([worker.close(), scheduledWorker.close(), memoryGraphRebuildWorker.close()]) // wait for in-flight jobs
    await Promise.all([
      scheduledQueue.close().catch(() => {}),
      memoryGraphRebuildQueue.close().catch(() => {}),
      ingestQueue.close().catch(() => {}),
      hb.quit().catch(() => {}),
    ])
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  console.log(
    `[worker] up (mode=${config.EMBEDDING_MODE}, concurrency=${config.WORKER_CONCURRENCY}, scheduled=${SCHEDULED_HANDLERS.length} jobs, memory-graph-rebuild=ready)`,
  )
}

void main().catch((err) => {
  console.error('ERROR: [worker] fatal boot error:', err)
  process.exit(1)
})
