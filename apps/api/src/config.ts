/**
 * persistent-memory-api — environment config (Phase 3).
 *
 * Zod-validates process.env ONCE at boot and exports a typed, frozen `config`.
 * A missing/invalid required var fails fast with an actionable message instead
 * of surfacing as a confusing runtime null later.
 *
 * The connection-role split is the security spine (carried from P2):
 *   • DATABASE_URL          → pm_app   (RLS-SUBJECT runtime role; data plane)
 *   • DATABASE_MIGRATE_URL  → pmuser   (OWNER; control plane: app_user/team/
 *                                        team_grant — these are NOT RLS-bound and
 *                                        pm_app has no grant on them)
 * Using DATABASE_URL (pm_app) for control-table reads → permission denied; using
 * DATABASE_MIGRATE_URL (owner) for data reads → silently bypasses RLS. Each
 * client has exactly one correct job (see packages/db/src/prisma.ts).
 */
import 'dotenv/config'
import { z } from 'zod/v4'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(8090),

  // Deployment mode (Phase 13, #Part5). `local` = a single-user, NO-AUTH stack:
  // the api reads a DB-backed local super-user (member of one seeded team) on
  // every request instead of verifying a Bearer token, and the dashboard skips
  // login. `server` (default) is the full multi-team token-authed deployment —
  // UNCHANGED. SECURITY: this is a BOOT/DEPLOY-TIME pin (read ONCE here, never a
  // runtime-flippable SystemSettings row), so a request can never flip auth off.
  // Only the onboard full-local flow sets it; NEVER set it on a shared/networked host.
  DEPLOYMENT_MODE: z.enum(['server', 'local']).default('server'),

  // A deliberately visible marker for the disposable integration stack. It is
  // never enabled by an installer or normal deployment. The HTTP integration
  // suite refuses to mutate an API unless this deploy-time marker is true.
  PM_TEST_STACK: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),

  // Full-local identity (P1, full-local redesign). The onboarding "account" step writes
  // these to .env; ensureLocalIdentity SEEDS the single local team + super-user from them.
  // The installer also stamps LOCAL_USER_PASSWORD_CONFIGURED_AT so reinstalling over a
  // preserved DB can apply the wizard's current optional dashboard lock exactly once;
  // later profile edits have a newer passwordChangedAt and keep winning.
  // LOCAL_USER_PASSWORD is plaintext in the gitignored, local-only .env (consistent with
  // the DB passwords already there) and hashed into app_user.password_hash in local mode.
  LOCAL_TEAM_NAME: z.string().default(''),
  LOCAL_USER_EMAIL: z.string().default(''),
  LOCAL_USER_DISPLAY_NAME: z.string().default(''),
  LOCAL_USER_PASSWORD: z.string().default(''),
  LOCAL_USER_PASSWORD_CONFIGURED_AT: z.string().default(''),

  // Data-plane connection — pm_app (NOSUPERUSER / NOBYPASSRLS, RLS-subject).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL (pm_app) must be set'),
  // Control-plane / owner connection — pmuser. Used for token verify, identity
  // resolution (team_grant), local mode identity (local_identity), and the P9 dashboard
  // ops on the control tables (teams/users/tokens/grants/system_settings via routes/dashboard/*).
  DATABASE_MIGRATE_URL: z
    .string()
    .min(1, 'DATABASE_MIGRATE_URL (pmuser owner) must be set'),

  // Token auth. The pepper is an app-side secret appended to the secret before
  // argon2id hashing — never stored in the DB, so a DB dump alone can't be
  // brute-forced. Empty string is permitted (dev parity with the seed default).
  TOKEN_PEPPER: z.string().default(''),
  // Partition Graphiti by memory surface + team + project. Operators may rotate
  // this only through the explicit graph rebuild migration; token pepper is a
  // backwards-compatible fallback for existing installs.
  GRAPH_GROUP_SECRET: z.string().default(''),
  // A local installation is Personal by default; shared servers set this to
  // shared. The optional value preserves old env files during the installer
  // migration.
  MEMORY_SURFACE: z.enum(['personal', 'shared']).optional(),

  // argon2id params — kept in lockstep with layers/core/schema/seed.ts so the bootstrap
  // token verifies. (verify() reads params embedded in the stored hash, so
  // these only matter for issue/rotate, exposed by the P9 dashboard token routes
  // — POST /dashboard/users/:id/token[/rotate] via auth/token-service.issueToken.)
  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  // ── Phase 6: ingest pipeline (MinIO blob store + BullMQ producer). ─────────
  // MinIO endpoint is a full URL; @pm/shared/storage parses it into host/port/SSL.
  MINIO_ENDPOINT: z.string().min(1, 'MINIO_ENDPOINT must be set'),
  MINIO_ROOT_USER: z.string().min(1, 'MINIO_ROOT_USER must be set'),
  MINIO_ROOT_PASSWORD: z.string().min(1, 'MINIO_ROOT_PASSWORD must be set'),
  MINIO_REGION: z.string().default('us-east-1'),
  // BullMQ broker — the api is the producer (enqueues on POST /ingest).
  REDIS_URL: z.string().min(1, 'REDIS_URL must be set for the BullMQ ingest queue'),
  GRAPHITI_URL: z.string().min(1).default('http://persistent-memory-graphiti:8100'),
  QDRANT_API_KEY: z.string().default(''),
  FALKORDB_PASSWORD: z.string().default(''),
  // Per-call abort deadline for the Graphiti HTTP client (P7 graph proxy reads).
  GRAPHITI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Host Ollama (for the Services monitor reachability row).
  OLLAMA_URL: z.string().url().default('http://host.docker.internal:11434'),
  // The local Services monitor (/dashboard/services) does NOT touch the Docker socket
  // itself. It calls the `docker-control` sidecar (the only container with the
  // socket) over the internal compose network, presenting a shared-secret bearer.
  // The routes still gate the surface (state/log reads = any authenticated user,
  // mutations = superuser; service UI credentials = admin/superuser only); the
  // sidecar adds the token + verb-boundary. Absent/empty token or unreachable
  // sidecar → the feature degrades (503 docker_unavailable), never crashes.
  DOCKER_CONTROL_URL: z.string().url().default('http://persistent-memory-docker-control:9090'),
  DOCKER_CONTROL_TOKEN: z.string().default(''),
  // Snapshot-safe update runner. It is intentionally separate from docker-control:
  // docker-control keeps the tiny list/log/start/stop boundary, while the runner
  // owns the privileged git/compose/migrate update flow behind its own token.
  UPDATE_RUNNER_URL: z.string().url().default('http://persistent-memory-update-runner:9092'),
  UPDATE_RUNNER_TOKEN: z.string().default(''),
  // Shared secret for POST /internal/usage (graphiti-service reports its LLM token
  // usage there). Constant-time check, EMPTY ⇒ the endpoint rejects everything
  // (fail-closed) — mirrors DOCKER_CONTROL_TOKEN.
  USAGE_INGEST_TOKEN: z.string().default(''),
  // Reject oversized uploads before they stream to MinIO. Default 100 MiB.
  INGEST_MAX_FILE_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  // Presigned MinIO download-URL TTL (P7 get_document). S3 caps at 604800s (7d);
  // default 1h. Clamped to the cap at mint time in the route.
  DOC_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().max(604_800).default(3600),
  // DLP / PII write-gate (Phase 8, #10). The api calls the dlp sidecar to block
  // memory writes carrying PII (Presidio) or secrets (gitleaks). FAIL-CLOSED: an
  // unreachable/erroring sidecar blocks the write. PII_GATE_ENABLED=false disables
  // the gate entirely (NOT recommended). PII_ENTITIES is the comma-separated deny-list
  // (empty ⇒ the structured-PII default in @pm/shared). The gate runs between the
  // Stage-1 pre-gate and the Stage-2 LLM (cheap-first).
  DLP_URL: z.string().url().default('http://persistent-memory-dlp:8200'),
  // NOT z.coerce.boolean() — that treats any non-empty string (incl. "false") as
  // true. Fail-safe: the gate stays ON unless the value is exactly "false".
  PII_GATE_ENABLED: z.string().default('true').transform((v) => v.toLowerCase() !== 'false'),
  PII_ENTITIES: z.string().default(''),
  PII_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  DLP_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  // Memory rerank (Phase 9, #11) — the Generative-Agents formula weights + recency
  // half-life. Advanced tuning (env); the retired archive feature no longer has
  // confidence threshold + TTL) live in SystemSettings (dashboard-configurable).
  RERANK_ALPHA: z.coerce.number().min(0).default(1.0),
  RERANK_BETA: z.coerce.number().min(0).default(0.3),
  RERANK_GAMMA: z.coerce.number().min(0).default(0.2),
  RERANK_HALFLIFE_DAYS: z.coerce.number().positive().default(30),
})

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) {
  // z.treeifyError gives a compact, field-keyed view of what's wrong.
  console.error(
    'ERROR: [config] Invalid environment:',
    JSON.stringify(z.treeifyError(parsed.error), null, 2),
  )
  throw new Error('Invalid environment configuration — see log above.')
}

export type AppConfig = Readonly<z.infer<typeof EnvSchema>>
export const config: AppConfig = Object.freeze(parsed.data)
