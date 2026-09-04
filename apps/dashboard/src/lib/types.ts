/**
 * persistent-memory-dashboard — DTO types.
 *
 * Hand-mirrored from the api's Zod response shapes
 * (apps/api/src/routes/dashboard/*.ts + routes/whoami.ts). The dashboard app is NOT a
 * @pm/* workspace member (it never
 * touches Postgres / Prisma), so these are duplicated deliberately. If the api
 * response shape changes, update here too.
 */

export type AdminLevel = 'none' | 'admin' | 'superuser'
export type EmbeddingMode = 'server' | 'client-bridge'
export type EmbeddingTopology = 'server-managed-embeddings' | 'client-managed-embeddings'
export type MemorySurface = 'personal' | 'shared'
export type DashboardLoginMode = 'password' | 'sso'

export interface PublicConfig {
  embeddingTopology: EmbeddingTopology
  /** Deprecated compatibility alias. Prefer embeddingTopology. */
  embeddingMode: EmbeddingMode
  activeModel: string
  activeDim: number
  activeVectorName: string
  deploymentMode: 'server' | 'local'
  dashboardLoginMode: DashboardLoginMode
}

export interface PasswordLoginResult {
  sessionToken: string
  passwordTemporary: boolean
}

/** GET /whoami — server-derived identity (access model: documentation/stack-architecture/access-model.md). */
export interface WhoAmI {
  userId: string
  teamId: string | null
  userDisplayName?: string | null
  userEmail?: string | null
  /** P1 — human-readable team name (shown by the logout control). Null when team-less. */
  teamName?: string | null
  adminLevel: AdminLevel
  isTeamMember: boolean
  isTeamAdmin: boolean
  isGlobalSuperuser: boolean
  /** Phase 13 — deploy-time topology (optional: older api builds omit it). */
  deploymentMode?: 'server' | 'local'
}

/** GET /profile — the caller's own self-service profile (P1). */
export interface Profile {
  userId: string
  displayName: string | null
  email: string | null
  adminLevel: AdminLevel
  teamId: string | null
  teamName: string | null
  hasPassword: boolean
  passwordTemporary: boolean
  recoveryToken?: string
}

/** GET /dashboard/teams[].teams */
export interface Team {
  id: string
  name: string
  memberCount: number
  createdAt: string
  updatedAt: string
}

/** A team in the grants matrix axes (no counts). */
export interface TeamRef {
  id: string
  name: string
}

/** GET /dashboard/users[].users — NEVER carries tokenHash. teamId null = team-less superuser. */
export interface User {
  id: string
  teamId: string | null
  adminLevel: AdminLevel
  email: string | null
  displayName: string | null
  tokenId: string | null
  tokenExpires: string | null
  tokenIssuedAt: string | null
  hasToken: boolean
  hasPassword: boolean
  passwordTemporary: boolean
  passwordChangedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PasswordResetResult {
  user: User
  password: string
}

/** POST/POST-rotate /dashboard/users/:id/token — the wire token, shown ONCE. */
export interface IssuedToken {
  tokenId: string
  wireToken: string
  expiresAt: string | null
}

/** A memory row (GET /dashboard/memories[].results or the data-plane /memories[].results). */
export interface Memory {
  id: string
  teamId: string
  content: string
  category: string
  shape: string
  entities: string[]
  project: string
  sessionId: string | null
  createdById: string | null
  /** 'pending' | 'embedded' — present on admin-plane rows; absent on some data-plane rows. */
  embeddingStatus?: string
  score?: number
  isOwnTeam?: boolean
  createdAt: string
  recordUpdatedAt: string
  updatedAt?: string
  // Provenance + lifecycle fields present on dashboard-plane rows.
  memoryTier?: string
  sourceProvenance?: string
  confidence?: number
  graphPrimary?: boolean
  graphPrimaryFactCount?: number
}

export interface MemoryGraphNode {
  id: string
  kind: 'memory' | 'entity'
  displayLabel: string
  project: string
  category: string | null
  relation: 'own' | 'granted'
  surface: MemorySurface
  memoryId: string | null
  entityUuid: string | null
  graphStatus: string | null
}

export interface MemoryGraphEdge {
  id: string
  source: string
  target: string
  kind: 'mentions' | 'fact'
  label: string | null
  historical: boolean
  project: string
  relation: 'own' | 'granted'
  surface: MemorySurface
}

export interface MemoryGraphSnapshot {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  counts: {
    totalFilteredMemories: number
    loadedMemories: number
    loadedEntities: number
    loadedEdges: number
  }
  partial: boolean
  partialReason: string | null
  nextCursor: string | null
  graphRevision: string
  snapshotAt: string
}

export interface MemoryGraphFacet {
  value: string
  count: number
  lastChangedAt: string
}

export interface MemoryGraphFacets {
  projects: MemoryGraphFacet[]
  tags: MemoryGraphFacet[]
  badges: MemoryGraphFacet[]
  partial: boolean
}

export interface MemoryGraphActivity {
  memoryId: string
  kind: 'created' | 'updated' | 'read'
  occurredAt: string
  project: string
  category: string
  entities: string[]
  displayLabel: string
}

export interface MemoryGraphActivityResult {
  events: MemoryGraphActivity[]
  nextCursor: string
  partial: boolean
  serverTime: string
}

export interface MemoryGraphFilters {
  projects: string[]
  tags: string[]
  badges: string[]
  validity: 'all' | 'current' | 'historical'
}

export interface GraphDeletePreview {
  token: string
  primaryFactCount: number
  episodeCount: number
  expiresAt: string
}

/** A single-use, scope-bound preview for a dashboard bulk deletion. */
export interface BulkGraphDeletePreview {
  token: string
  memoryCount: number
  episodeCount: number
  primaryMemoryCount: number
  primaryFactCount: number
  /** False for a Shared member when the selected own-authored rows include a primary source. */
  canConfirmPrimary: boolean
  expiresAt: string
}

/** GET /dashboard/memories/pending — rows awaiting embedding (backfill targets). */
export interface PendingEmbeddings {
  memories: number
  chunks: number
  embeddingMode: string
}

export interface MemoryGraphRebuildResult {
  jobId: string
  matched: number
  filters: {
    teamId?: string
    project?: string
    createdById?: string
  }
}

export interface MemoryExportOptions {
  exportType?: 'standard' | 'secure'
  teamId?: string | null
  teamName?: string | null
  project?: string | null
  createdById?: string | null
}

export interface MemoryExportEnvelope {
  schema: string
  count: number
  exportedAt?: string
  exportOptions?: MemoryExportOptions
  filters?: {
    teamId?: string | null
    project?: string | null
    createdById?: string | null
  }
  memories: unknown[]
}

export interface MemoryImportErrorDetail {
  index: number
  id?: string
  stage: 'target_team' | 'authorization' | 'safety_scan' | 'write'
  message: string
}

export interface MemoryImportResult {
  imported: number
  embedded: number
  pending: number
  errors: number
  details: MemoryImportErrorDetail[]
}

/** A single directional MOUNT (was "grant"). (X grantor, Y grantee) = "Y mounts
 * X" = Y's MCP reads X's memories. Gates MCP cross-team memory reads only. */
export interface Grant {
  id: string
  grantorTeamId: string
  granteeTeamId: string
}

/** GET /dashboard/grants — the mount matrix payload. */
export interface GrantsMatrix {
  teams: TeamRef[]
  grants: Grant[]
}

/** A stack service row (GET /dashboard/services). */
export interface ServiceStatus {
  service: string
  name: string
  id: string
  state: string
  status: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
  controllable: boolean
  /** Host and logical capability rows deliberately never expose Docker logs. */
  logsAvailable?: boolean
  configuredModel?: string
  configuredModelState?: 'present' | 'missing' | 'not_configured'
  mcpSession?: boolean
  ui?: { label: string; url: string }
  credentials?: { label: string; value: string }[]
}

export interface McpClientStatus {
  id: string
  clientName: string
  connectionType: 'stream' | 'stdio'
  pid: number | null
  startedAt: string
  lastSeenAt: string
  lastActivityAt: string
  terminatesAt: string | null
  terminateSupported: boolean
  terminateRequested: boolean
}

export interface ReleaseServiceRow {
  service: string
  version: string
  change: string
}

export interface ReleaseNotes {
  version: string
  date: string
  latest: boolean
  services: ReleaseServiceRow[]
  mcpRestartRequired: boolean
  body: string
}

export interface UpdateRunSummary {
  ok: boolean
  startedAt: string
  finishedAt?: string
  backupPath?: string
  error?: string
}

export interface PostUpdateSignal {
  id: string
  source: 'update-script' | 'update-runner'
  version: string
  finishedAt: string
  branch?: string
  commit?: string
}

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  updateBranch?: string
  autoUpdateReady?: boolean
  currentCommit?: string
  latestCommit?: string
  releaseNotes?: ReleaseNotes | null
  mcpRestartRequired?: boolean
  running: boolean
  lastRun?: UpdateRunSummary
  lastSuccessfulUpdate?: PostUpdateSignal
  logs: string[]
}

export interface UpdateLogState {
  running: boolean
  logs: string[]
  lastRun?: UpdateRunSummary
}

export type UpdateSettingsProvider = 'none' | 'bitbucket' | 'git'
export type UpdateBitbucketScope = 'project' | 'user'
export interface UpdateNotificationSettings {
  enabled: boolean
  provider: UpdateSettingsProvider
  bitbucket: {
    url: string
    tokenConfigured: boolean
    scope: UpdateBitbucketScope
    project: string
    user: string
    repo: string
    branch: string
  }
}
export interface UpdateNotificationSettingsInput {
  enabled: boolean
  provider?: 'none' | 'bitbucket'
  bitbucket?: {
    url?: string
    token?: string
    scope?: UpdateBitbucketScope
    project?: string
    user?: string
    repo?: string
    branch?: string
  }
}
export interface UpdateConnectionTestResult {
  ok: true
  provider: 'bitbucket'
  repository: string
  branch: string
  latestCommit: string
  latestVersion: string | null
}

export type BrowserPushNotificationType =
  | 'newReleases'
  | 'memoryAdded'
  | 'memoryUpdated'
  | 'memoryRemoved'
  | 'securityAlerts'

export interface BrowserPushSubscriptionInput {
  endpoint: string
  expirationTime?: number | null
  keys: {
    p256dh: string
    auth: string
  }
  notificationTypes?: BrowserPushNotificationType[]
  userAgent?: string
}

export interface BrowserPushPreferencesResult {
  count: number
  notificationTypes: BrowserPushNotificationType[]
}

export interface BrowserPushSendResult {
  sent: number
}

// ── Managed scheduled workers (GET /dashboard/workers) ──
/** A managed scheduled job row. Times are ISO strings; nextRunAt is live from BullMQ. */
export interface WorkerStatus {
  name: string
  description: string
  cron: string
  enabled: boolean
  status: string // idle | running | success | failed
  lastRunAt: string | null
  lastFinishAt: string | null
  lastDurationMs: number | null
  lastError: string | null
  logTail: string | null
  errorCount: number
  nextRunAt: string | null
}
/** Worker-process liveness (from the heartbeat key). */
export interface WorkerLiveness {
  alive: boolean
  lastBeatAgoMs: number | null
}
/** GET /dashboard/workers/:name/logs — last-run summary + error. */
export interface WorkerLog {
  name: string
  status: string
  logTail: string | null
  lastError: string | null
  lastRunAt: string | null
  lastFinishAt: string | null
}
export type WorkerAction = 'pause' | 'resume' | 'run-now'

/** Phase 10 (#5): live embedding-model-switch status (null = idle). */
export interface EmbeddingSwitchStatus {
  state: 'running' | 'done' | 'failed'
  from: { model: string; dim: number }
  to: { model: string; dim: number }
  migrated: number
  startedAt: string
  finishedAt?: string
  error?: string
}

export type FactExtractionProvider = 'anthropic' | 'openai'
export type FactExtractionKeySource = 'settings' | 'env' | 'missing'
export interface FactExtractionModelOption {
  value: string
  label: string
  provider: FactExtractionProvider
}
export interface FactExtractionKeyState {
  hasKey: boolean
  source: FactExtractionKeySource
  masked: string | null
}
export interface FactExtractionSettings {
  provider: FactExtractionProvider
  model: string
  apiKeyMasked: string | null
  apiKeySource: FactExtractionKeySource
  availableModels: FactExtractionModelOption[]
  keys: Record<FactExtractionProvider, FactExtractionKeyState>
}
export interface SettingsTestResult {
  ok: boolean
  provider?: FactExtractionProvider
  model: string
  message: string
  details?: string
  outcome?: 'accept' | 'restructure' | 'reject'
  reason?: string
  health?: ModelDependencyHealth
}

/** GET /dashboard/settings + the non-warning part of PUT. */
export interface Settings {
  embeddingTopology: EmbeddingTopology
  /** Deprecated compatibility alias. Prefer embeddingTopology. */
  embeddingMode: EmbeddingMode
  activeEmbedModel: string
  activeEmbedDim: number
  activeVectorName: string
  persisted: boolean
  updatedAt: string | null
  mcpSessionIdleTimeoutSeconds: number
  // Phase 10 (#5): live model-switch status (null = idle).
  embeddingSwitch: EmbeddingSwitchStatus | null
  // Fact extraction (Memory Shape gate): model + masked provider-key state.
  factExtraction: FactExtractionSettings
  dashboardLoginMode: DashboardLoginMode
  capabilityHealth: DashboardCapabilityHealth
}

/** PUT /dashboard/settings response — adds the model-change warning. */
export interface SettingsUpdateResult extends Settings {
  modelChanged: boolean
  /** True when a live server-managed re-embed migration was kicked off. */
  switchStarted?: boolean
  warning?: string
}

export interface SharedConnectionCompatibility {
  ok: boolean
  requiresLocalEmbedding: boolean
  reason?: string
}

export interface SharedRemoteConfig {
  embeddingTopology: EmbeddingTopology
  embeddingMode?: EmbeddingMode
  activeModel: string
  activeDim: number
  activeVectorName?: string
  deploymentMode?: 'server' | 'local'
  dashboardLoginMode?: DashboardLoginMode
}

export interface SharedConnectionStatus {
  configured: boolean
  apiUrl: string | null
  tokenConfigured: boolean
  token?: string
  connectedAt: string | null
  checkedAt: string | null
  remoteConfig: SharedRemoteConfig | null
  remoteIdentity: WhoAmI | null
  compatibility: SharedConnectionCompatibility | null
}

export interface SharedConnectionTestResult {
  config: SharedRemoteConfig
  whoami: WhoAmI
  compatibility: SharedConnectionCompatibility
}

// ── Usage metrics (GET /dashboard/usage) ──
export type UsageWindow = 'live' | '24h' | '7d' | '30d' | '90d'
export interface UsageRow {
  service: string
  model: string
  tokensIn: number
  tokensOut: number
  requests: number
  avgTokensPerReq: number
  rpm: number
  cost: number
  estimated: boolean
}
export interface UsageTotals {
  tokens: number
  requests: number
  cost: number
}
export interface UsageTrendPoint {
  t: string
  tokens: number
}
export interface UserUsageRow {
  userId: string | null
  displayName: string
  email: string | null
  tokens: number
  requests: number
}
export interface UsageResponse {
  window: string
  totals: UsageTotals
  rows: UsageRow[]
  trend: UsageTrendPoint[]
  users: UserUsageRow[]
  capabilityHealth: DashboardCapabilityHealth
}

// ── Overview dashboard (GET /dashboard/overview) ──
export interface OverviewSummary {
  counts: {
    teams: number
    users: number
    superusers: number
    admins: number
    memories: number
  }
  services: {
    total: number
    active: number
    stopped: number
    failed: number
    healthy: number
    unhealthy: number
    starting: number
    unavailable: boolean
  }
  mcpSessions: {
    active: number
    stream: number
    legacy: number
    serviceStatus: 'running' | 'stopped' | 'error' | 'unknown'
  }
  workers: {
    total: number
    enabled: number
    running: number
    failed: number
    alive: boolean
    lastBeatAgoMs: number | null
  }
  usage: {
    window: '24h'
    tokens: number
    requests: number
    cost: number
  }
  settings: {
    embeddingMode: string
    activeEmbedModel: string
    activeEmbedDim: number
    activeVectorName: string
    persisted: boolean
    factExtractionModel: string
    factExtractionProvider: string
  }
  capabilityHealth: DashboardCapabilityHealth
}

/** Canonical, redacted dependency health returned by the API control plane. */
export interface ModelDependencyHealth {
  capability: 'fact_extraction' | 'embeddings' | 'ollama_host'
  observerScope: string
  state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  provider: 'anthropic' | 'openai' | 'ollama' | 'voyage' | null
  model: string | null
  lastSuccessAt: string | null
  firstFailureAt: string | null
  lastFailureAt: string | null
  failureCode: string | null
  safeMessage: string | null
  retryable: boolean | null
  consecutiveFailures: number
  observedAt: string | null
  updatedAt: string | null
}

export interface DashboardCapabilityHealth {
  factExtraction: ModelDependencyHealth
  embeddings: ModelDependencyHealth
  ollamaHost: ModelDependencyHealth
}

// ── Security / DLP (Phase 8) ──────────────────────────────────────────────────
export interface SecurityAlert {
  id: string
  teamId: string
  project: string
  sourceKind: string
  rowId: string | null
  detector: string
  findingType: string
  severity: string
  redactedExcerpt: string | null
  count: number
  resolved: boolean
  resolvedAt: string | null
  createdAt: string
}
/** GET /dashboard/notify-settings — redaction-safe (BOTH Slack secrets are write-only;
 * the api returns *Configured booleans + the non-secret channel ids, never the raw
 * webhook URL or bot token). */
export interface NotifySettings {
  teamId: string | null
  enabled: boolean
  emailRecipients: string[]
  slackWebhookConfigured: boolean
  slackBotConfigured: boolean
  slackChannelIds: string[]
  minSeverity: string
}
/** PUT body — the Slack secrets are preserve-if-blank (omit/undefined = keep stored). */
export interface NotifySettingsInput {
  enabled: boolean
  emailRecipients: string[]
  slackWebhookUrl?: string | null
  slackBotToken?: string | null
  slackChannelIds: string[]
  minSeverity: string
}
