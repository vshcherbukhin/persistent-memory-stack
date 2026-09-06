/**
 * persistent-memory-onboard — .env generation.
 *
 * Renders the gitignored `.env.persistent-memory` from the wizard answers. The
 * load-bearing invariant: the password in DATABASE_URL MUST equal PM_APP_PASSWORD
 * (rls.sql injects PM_APP_PASSWORD into the pm_app role), and DATABASE_MIGRATE_URL's
 * password MUST equal POSTGRES_PASSWORD — so we build the connection strings FROM
 * the retained or generated secrets, never letting the user (or drift) set them apart.
 *
 * Secrets the user should NOT invent are auto-generated (TOKEN_PEPPER, DB/MinIO,
 * FalkorDB, Qdrant, and sidecar tokens) only when absent from the saved env.
 * Existing values are retained; cloud API keys come from the wizard.
 */
import { randomBytes } from 'node:crypto'

export interface Answers {
  embeddingMode: 'server' | 'client-bridge'
  embedProvider: 'ollama' | 'voyage' | 'openai'
  embedModel: string
  embedDim: number
  extractionProvider: 'anthropic' | 'openai'
  extractionModel: string
  anthropicApiKey?: string
  openaiApiKey?: string
  voyageApiKey?: string
  graphBackend: 'falkordb' | 'neo4j'
  semaphoreLimit?: number
  /** Phase 13: the full-local flow sets 'local' (single-user, no-auth stack);
   *  default/server otherwise. Only the full flow writes a .env, so this is 'local'
   *  for a self-hosted single-user install. */
  deploymentMode?: 'server' | 'local'
  /** P1 full-local account step — seed the single local team + super-user.
   *  userPassword is the OPTIONAL dashboard login (a soft UI lock; API/MCP stay no-auth).
   *  userPasswordConfiguredAt lets reinstalls over preserved DB volumes apply the
   *  wizard's latest password once while later dashboard profile changes keep winning. */
  teamName?: string
  userEmail?: string
  userName?: string
  userPassword?: string
  userPasswordConfiguredAt?: string
  /** @deprecated Node is accepted from older wizard state, but stream is the only runtime. */
  mcpRuntime?: 'stream' | 'node'
  personalMemoryEnabled?: boolean
  memoryInstallMode?: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface?: 'personal' | 'shared'
  personalApiUrl?: string
  sharedApiUrl?: string
  sharedUserToken?: string
}

export interface Secrets {
  tokenPepper: string
  postgresPassword: string
  pmAppPassword: string
  minioRootPassword: string
  falkordbPassword: string
  qdrantApiKey: string
  /** Shared secret the api presents to the docker-control sidecar (Services gate). */
  dockerControlToken: string
  /** Shared secret the api presents to the update-runner sidecar (update status gate). */
  updateRunnerToken: string
  /** Shared secret for the api's POST /internal/usage (graphiti reports token usage). */
  usageIngestToken: string
}

/** Preserve saved secret expressions verbatim; generate URL-safe values only when absent. */
export function genSecrets(existingEnv: Readonly<Record<string, string>> = {}): Secrets {
  const retainedOrGenerated = (key: string, bytes: number, encoding: 'hex' | 'base64url'): string => {
    const saved = existingEnv[key]
    // parseEnvFile retains dotenv quotes/comments. Copying the same expression
    // back without adding quotes preserves its effective value for Compose.
    return saved?.trim() ? saved : randomBytes(bytes).toString(encoding)
  }
  return {
    tokenPepper: retainedOrGenerated('TOKEN_PEPPER', 32, 'base64url'),
    postgresPassword: retainedOrGenerated('POSTGRES_PASSWORD', 18, 'hex'),
    pmAppPassword: retainedOrGenerated('PM_APP_PASSWORD', 18, 'hex'),
    minioRootPassword: retainedOrGenerated('MINIO_ROOT_PASSWORD', 18, 'hex'),
    falkordbPassword: retainedOrGenerated('FALKORDB_PASSWORD', 18, 'hex'),
    qdrantApiKey: retainedOrGenerated('QDRANT_API_KEY', 24, 'base64url'),
    dockerControlToken: retainedOrGenerated('DOCKER_CONTROL_TOKEN', 24, 'base64url'),
    updateRunnerToken: retainedOrGenerated('UPDATE_RUNNER_TOKEN', 24, 'base64url'),
    usageIngestToken: retainedOrGenerated('USAGE_INGEST_TOKEN', 24, 'base64url'),
  }
}

const POSTGRES_USER = 'pmuser'
const POSTGRES_DB = 'persistent_memory'
const MINIO_ROOT_USER = 'pmadmin'

export interface EnvValidationIssue {
  key: string
  message: string
}

const ALWAYS_REQUIRED_KEYS = [
  'TOKEN_PEPPER',
  'PM_HOST_BIND',
  'OLLAMA_URL',
  'EMBED_PROVIDER',
  'EMBED_MODEL',
  'EMBED_DIM',
  'EMBEDDING_MODE',
  'EXTRACTION_PROVIDER',
  'EXTRACTION_MODEL',
  'GRAPH_BACKEND',
  'SEMAPHORE_LIMIT',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'PM_APP_PASSWORD',
  'DATABASE_URL',
  'DATABASE_MIGRATE_URL',
  'REDIS_URL',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'MINIO_ENDPOINT',
  'GRAPHITI_URL',
  'API_PORT',
  'DEPLOYMENT_MODE',
  'ARGON2_MEMORY_KIB',
  'ARGON2_TIME_COST',
  'ARGON2_PARALLELISM',
  'PM_MCP_RUNTIME',
  'PM_PERSONAL_MEMORY_ENABLED',
  'PM_MEMORY_INSTALL_MODE',
  'PM_DEFAULT_MEMORY_SURFACE',
  'DOCKER_CONTROL_TOKEN',
  'UPDATE_RUNNER_TOKEN',
  'USAGE_INGEST_TOKEN',
] as const

function isBlank(value: string | undefined): boolean {
  const trimmed = value?.trim()
  return trimmed == null || trimmed === '' || trimmed === 'undefined' || trimmed === 'null'
}

function addRequired(out: EnvValidationIssue[], env: Record<string, string>, key: string): void {
  if (isBlank(env[key])) out.push({ key, message: `${key} is required before deployment.` })
}

export function streamContainerUrl(urlText: string | undefined, runtime: 'stream' | 'node' | undefined): string {
  const raw = (urlText ?? '').trim()
  if (runtime !== 'stream' || !raw) return raw
  try {
    const url = new URL(raw)
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      url.hostname = 'host.docker.internal'
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    return raw
  }
  return raw
}

export function validateEnvForDeploy(env: Record<string, string>): EnvValidationIssue[] {
  const out: EnvValidationIssue[] = []
  for (const key of ALWAYS_REQUIRED_KEYS) addRequired(out, env, key)

  if ((env.PM_MCP_RUNTIME ?? 'stream') !== 'stream') {
    out.push({ key: 'PM_MCP_RUNTIME', message: 'Stream MCP is the only supported runtime. Set PM_MCP_RUNTIME=stream.' })
  }
  addRequired(out, env, 'PM_MCP_STREAM_URL')
  if ((env.PM_PERSONAL_MEMORY_ENABLED ?? 'false') === 'true') addRequired(out, env, 'PM_PERSONAL_API_URL')
  if ((env.PM_MEMORY_INSTALL_MODE ?? 'shared-only') === 'personal-and-shared') {
    addRequired(out, env, 'PM_SHARED_API_URL')
    addRequired(out, env, 'PM_SHARED_USER_TOKEN')
  }

  const graph = (env.GRAPH_BACKEND ?? '').trim()
  if (graph === 'falkordb') {
    for (const key of ['FALKORDB_HOST', 'FALKORDB_PORT', 'FALKORDB_PASSWORD']) addRequired(out, env, key)
  } else if (graph === 'neo4j') {
    for (const key of ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'NEO4J_AUTH']) addRequired(out, env, key)
  }

  const extraction = (env.EXTRACTION_PROVIDER ?? '').trim()
  if (extraction === 'anthropic') addRequired(out, env, 'ANTHROPIC_API_KEY')
  if (extraction === 'openai') addRequired(out, env, 'OPENAI_API_KEY')

  const embed = (env.EMBED_PROVIDER ?? '').trim()
  if (embed === 'voyage') addRequired(out, env, 'VOYAGE_API_KEY')
  if (embed === 'openai') addRequired(out, env, 'OPENAI_API_KEY')

  return out
}

/** Render the full .env.persistent-memory contents (deterministic given inputs).
 * Existing runtime flags come from the server's saved env, never wizard answers. */
export function renderEnv(a: Answers, s: Secrets, existingEnv: Readonly<Record<string, string>> = {}): string {
  const databaseUrl = `postgresql://pm_app:${s.pmAppPassword}@persistent-memory-postgres:5432/${POSTGRES_DB}`
  const migrateUrl = `postgresql://${POSTGRES_USER}:${s.postgresPassword}@persistent-memory-postgres:5432/${POSTGRES_DB}`
  const memoryInstallMode = a.memoryInstallMode ?? (a.deploymentMode === 'local' ? 'personal-only' : 'shared-only')
  const personalMemoryEnabled = a.personalMemoryEnabled ?? memoryInstallMode !== 'shared-only'
  const defaultMemorySurface = a.defaultMemorySurface ?? (personalMemoryEnabled ? 'personal' : 'shared')
  // parseEnvFile retains dotenv quotes/comments; Compose removes them before the
  // dashboard reads this flag. Recognize only the literal false opt-out here.
  const graphUiDisabled = /^(?:false|(['"])false\1)(?:[ \t]+#.*)?$/.test(existingEnv.PM_MEMORY_GRAPH_UI_ENABLED?.trim() ?? '')
  const sharedApiUrl = streamContainerUrl(a.sharedApiUrl, a.mcpRuntime)
  return [
    '# persistent-memory — generated by the onboarding installer. Gitignored.',
    '',
    '# ── Secrets ──',
    `ANTHROPIC_API_KEY=${a.anthropicApiKey ?? ''}`,
    `OPENAI_API_KEY=${a.openaiApiKey ?? ''}`,
    `VOYAGE_API_KEY=${a.voyageApiKey ?? ''}`,
    `TOKEN_PEPPER=${s.tokenPepper}`,
    'PM_HOST_BIND=127.0.0.1',
    '',
    '# ── Embeddings ──',
    'OLLAMA_URL=http://host.docker.internal:11434',
    `EMBED_PROVIDER=${a.embedProvider}`,
    `EMBED_MODEL=${a.embedModel ?? ''}`,
    `EMBED_DIM=${a.embedDim ?? ''}`,
    `EMBEDDING_MODE=${a.embeddingMode}`,
    '',
    '# ── LLM extraction ──',
    `EXTRACTION_PROVIDER=${a.extractionProvider}`,
    `EXTRACTION_MODEL=${a.extractionModel}`,
    '',
    '# ── Graph backend ──',
    `GRAPH_BACKEND=${a.graphBackend}`,
    `SEMAPHORE_LIMIT=${a.semaphoreLimit ?? 10}`,
    'FALKORDB_HOST=persistent-memory-falkordb',
    'FALKORDB_PORT=6379',
    `FALKORDB_PASSWORD=${s.falkordbPassword}`,
    'NEO4J_AUTH=neo4j/persistentmemory',
    'NEO4J_URI=bolt://persistent-memory-neo4j:7687',
    'NEO4J_USER=neo4j',
    'NEO4J_PASSWORD=persistentmemory',
    '',
    '# ── Qdrant ──',
    'QDRANT_URL=http://persistent-memory-qdrant:6333',
    `QDRANT_API_KEY=${s.qdrantApiKey}`,
    '',
    '# ── Postgres ──',
    `POSTGRES_USER=${POSTGRES_USER}`,
    `POSTGRES_PASSWORD=${s.postgresPassword}`,
    `POSTGRES_DB=${POSTGRES_DB}`,
    `PM_APP_PASSWORD=${s.pmAppPassword}`,
    `DATABASE_URL=${databaseUrl}`,
    `DATABASE_MIGRATE_URL=${migrateUrl}`,
    '',
    '# ── Redis (BullMQ) ──',
    'REDIS_URL=redis://persistent-memory-redis:6379',
    '',
    '# ── MinIO ──',
    `MINIO_ROOT_USER=${MINIO_ROOT_USER}`,
    `MINIO_ROOT_PASSWORD=${s.minioRootPassword}`,
    'MINIO_ENDPOINT=http://persistent-memory-minio:9000',
    '',
    '# ── Graphiti ──',
    'GRAPHITI_URL=http://persistent-memory-graphiti:8100',
    '',
    '# ── API ──',
    'API_PORT=8090',
    '# Deployment mode (Phase 13). local = single-user NO-AUTH stack (the full-local',
    '# install). NEVER set local on a shared/networked host.',
    `DEPLOYMENT_MODE=${a.deploymentMode ?? 'server'}`,
    'ARGON2_MEMORY_KIB=19456',
    'ARGON2_TIME_COST=2',
    'ARGON2_PARALLELISM=1',
    '',
    '# ── Local identity (full-local single-user). Seeded by ensureLocalIdentity, then',
    '#    managed in the dashboard profile/team-settings. LOCAL_USER_PASSWORD is the',
    '#    OPTIONAL dashboard login — a soft UI lock only (the local API/MCP stay no-auth);',
    '#    blank = dashboard opens directly. LOCAL_USER_PASSWORD_CONFIGURED_AT lets a',
    '#    reinstall over preserved memories apply the wizard choice once; newer dashboard',
    '#    profile changes keep winning. ──',
    `LOCAL_TEAM_NAME=${(a.teamName ?? '').trim() || 'QA'}`,
    `LOCAL_USER_EMAIL=${a.userEmail ?? ''}`,
    `LOCAL_USER_DISPLAY_NAME=${a.userName ?? ''}`,
    `LOCAL_USER_PASSWORD=${a.userPassword ?? ''}`,
    `LOCAL_USER_PASSWORD_CONFIGURED_AT=${a.userPasswordConfiguredAt ?? ''}`,
    '',
    '# ── MCP runtime ──',
    '# Streamable HTTP MCP service. Legacy node runtime inputs are ignored.',
    `PM_MCP_RUNTIME=${a.mcpRuntime === 'node' ? 'stream' : a.mcpRuntime ?? 'stream'}`,
    'PM_MCP_STREAM_URL=http://127.0.0.1:8091/mcp',
    '',
    '# ── Memory surfaces ──',
    '# shared-only = remote/company memory only; personal-only = local private memory only;',
    '# personal-and-shared = local private memory plus explicit routing to the shared server.',
    `PM_PERSONAL_MEMORY_ENABLED=${personalMemoryEnabled ? 'true' : 'false'}`,
    `PM_MEMORY_INSTALL_MODE=${memoryInstallMode}`,
    `PM_DEFAULT_MEMORY_SURFACE=${defaultMemorySurface}`,
    `PM_MEMORY_GRAPH_UI_ENABLED=${graphUiDisabled ? 'false' : 'true'}`,
    `PM_PERSONAL_API_URL=${a.personalApiUrl ?? 'http://localhost:8090'}`,
    `PM_SHARED_API_URL=${sharedApiUrl}`,
    `PM_SHARED_USER_TOKEN=${a.sharedUserToken ?? ''}`,
    '',
    '# ── Services control (docker-control sidecar — the only container with the',
    '#    Docker socket). The api presents this shared secret; the sidecar fails',
    '#    closed if it is empty. No host port is published for the sidecar. ──',
    `DOCKER_CONTROL_TOKEN=${s.dockerControlToken}`,
    '# Shared secret for the update-runner sidecar (dashboard update status).',
    `UPDATE_RUNNER_TOKEN=${s.updateRunnerToken}`,
    '# Shared secret for the api POST /internal/usage endpoint (graphiti token-usage reporting).',
    `USAGE_INGEST_TOKEN=${s.usageIngestToken}`,
    '# Docker socket group override for native Linux only; Docker Desktop usually uses 0.',
    'DOCKER_GID=0',
    '',
    '# ── DLP / PII gate ──',
    'PII_GATE_ENABLED=true',
    'PII_ENTITIES=',
    'PII_SCORE_THRESHOLD=0.5',
    'DLP_TIMEOUT_MS=4000',
    'PII_INGEST_GATE_ENABLED=true',
    '',
    '# ── Security-alert notifications ──',
    'SMTP_HOST=',
    'SMTP_PORT=587',
    'SMTP_SECURE=false',
    'SMTP_USER=',
    'SMTP_PASS=',
    'ALERT_EMAIL_FROM=',
    '',
    '# ── Memory rerank ──',
    'RERANK_ALPHA=1.0',
    'RERANK_BETA=0.3',
    'RERANK_GAMMA=0.2',
    'RERANK_HALFLIFE_DAYS=30',
    '',
  ].join('\n')
}

/** Mask secret values for the UI review (keep the first/last few chars). */
export function maskEnv(env: string): string {
  const SECRET_KEYS = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|VOYAGE_API_KEY|TOKEN_PEPPER|POSTGRES_PASSWORD|PM_APP_PASSWORD|MINIO_ROOT_PASSWORD|FALKORDB_PASSWORD|QDRANT_API_KEY|DOCKER_CONTROL_TOKEN|UPDATE_RUNNER_TOKEN|USAGE_INGEST_TOKEN|LOCAL_USER_PASSWORD|PM_SHARED_USER_TOKEN|SMTP_PASS)=(.+)$/
  return env
    .split('\n')
    .map((line) => {
      const m = SECRET_KEYS.exec(line)
      if (!m) return line
      const val = m[2]!
      const shown = val.length <= 8 ? '••••' : `${val.slice(0, 3)}…${val.slice(-2)}`
      return `${m[1]}=${shown}`
    })
    .join('\n')
}
