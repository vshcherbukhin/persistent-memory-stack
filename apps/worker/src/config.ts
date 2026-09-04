/**
 * persistent-memory-worker — environment config (Phase 6).
 *
 * Zod-validates process.env ONCE at boot. The worker is a data-plane writer
 * (chunks team-stamped) → it connects as pm_app (DATABASE_URL) and writes via
 * @pm/db's runInTenant. DATABASE_MIGRATE_URL is kept for parity / future control
 * reads. EMBEDDING_MODE drives step 5 (Mode A embeds; Mode B leaves pending).
 */
import 'dotenv/config'
import { z } from 'zod/v4'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DEPLOYMENT_MODE: z.enum(['server', 'local']).default('server'),

  // Data-plane connection — pm_app (RLS-subject). Owner kept for parity.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL (pm_app) must be set'),
  DATABASE_MIGRATE_URL: z.string().min(1, 'DATABASE_MIGRATE_URL (pmuser owner) must be set'),

  REDIS_URL: z.string().min(1, 'REDIS_URL must be set for the BullMQ connection'),
  QDRANT_URL: z.string().min(1).default('http://persistent-memory-qdrant:6333'),
  GRAPHITI_URL: z.string().min(1).default('http://persistent-memory-graphiti:8100'),
  GRAPH_GROUP_SECRET: z.string().default(''),
  TOKEN_PEPPER: z.string().default(''),
  MEMORY_SURFACE: z.enum(['personal', 'shared']).optional(),

  // MinIO (parsed inside @pm/shared resolveMinioConfig; validated here for fast-fail).
  MINIO_ENDPOINT: z.string().min(1, 'MINIO_ENDPOINT must be set'),
  MINIO_ROOT_USER: z.string().min(1, 'MINIO_ROOT_USER must be set'),
  MINIO_ROOT_PASSWORD: z.string().min(1, 'MINIO_ROOT_PASSWORD must be set'),
  MINIO_REGION: z.string().default('us-east-1'),

  // Embedding topology + pin (Mode A only constructs an embedder).
  EMBEDDING_MODE: z.enum(['server', 'client-bridge']).default('server'),

  // Tunables.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  GRAPHITI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  CHUNK_MAX_TOKENS: z.coerce.number().int().positive().default(512),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().nonnegative().default(64),
  // The worker's OWN read ceiling (Phase 12, #8) — mirrors the api's upload cap, but
  // defends in depth: a blob larger than this (e.g. uploaded out-of-band) is rejected
  // via a bounded read (getBufferCapped) BEFORE it can OOM the worker. Peak worker
  // memory ≈ INGEST_MAX_FILE_BYTES × WORKER_CONCURRENCY × ~a-few; keep the container
  // mem_limit (docker-compose) above that, or lower this / WORKER_CONCURRENCY.
  INGEST_MAX_FILE_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),

  // DLP / PII (Phase 8, #10). The worker scans ingested DOCUMENTS (block on
  // detection) and runs the periodic pii-scan over stored memories/chunks.
  DLP_URL: z.string().url().default('http://persistent-memory-dlp:8200'),
  DLP_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  PII_ENTITIES: z.string().default(''),
  PII_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  // NOT z.coerce.boolean() (treats "false" as true). Fail-safe: ON unless "false".
  PII_INGEST_GATE_ENABLED: z.string().default('true').transform((v) => v.toLowerCase() !== 'false'),

  // Security-alert notifications (best-effort; never block). SMTP RELAY creds; the
  // per-team recipients + Slack webhooks come from the NotifySettings table.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  ALERT_EMAIL_FROM: z.string().default(''),
})

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) {
  console.error(
    'ERROR: [worker config] Invalid environment:',
    JSON.stringify(z.treeifyError(parsed.error), null, 2),
  )
  throw new Error('Invalid worker environment configuration — see log above.')
}

export type WorkerConfig = Readonly<z.infer<typeof EnvSchema>>
export const config: WorkerConfig = Object.freeze(parsed.data)
