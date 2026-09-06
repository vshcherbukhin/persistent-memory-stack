import 'server-only'
import { cookies } from 'next/headers'
import { SESSION_COOKIE } from './session'
import type {
  WhoAmI,
  Team,
  User,
  IssuedToken,
  Memory,
  MemoryExportEnvelope,
  MemoryGraphRebuildResult,
  MemoryImportResult,
  PendingEmbeddings,
  ServiceStatus,
  McpClientStatus,
  WorkerStatus,
  WorkerLiveness,
  WorkerLog,
  WorkerAction,
  Grant,
  GrantsMatrix,
  Settings,
  SettingsUpdateResult,
  Profile,
  AdminLevel,
  EmbeddingMode,
  SettingsTestResult,
  UsageResponse,
  UsageWindow,
  OverviewSummary,
  SecurityAlert,
  NotifySettings,
  NotifySettingsInput,
  UpdateLogState,
  UpdateStatus,
  MemorySurface,
  PublicConfig,
  PasswordLoginResult,
  DashboardLoginMode,
  PasswordResetResult,
  SharedConnectionStatus,
  SharedConnectionTestResult,
  BrowserPushNotificationType,
  BrowserPushPreferencesResult,
  BrowserPushSendResult,
  BrowserPushSubscriptionInput,
  DashboardCapabilityHealth,
  MemoryGraphActivityResult,
  MemoryGraphFacets,
  MemoryGraphFilters,
  MemoryGraphSnapshot,
} from './types'

/**
 * persistent-memory-dashboard — typed, SERVER-ONLY dashboard API client.
 *
 * `import 'server-only'` is the guardrail: any accidental import of this module
 * from a Client Component fails the build, so the raw token (read from the
 * httpOnly cookie below) can never leak into the browser bundle. ALL dashboard API
 * calls run server-side (Server Actions / RSC) and attach the Bearer here.
 *
 * BASE = API_URL — the compose-internal, server-side URL
 * (http://persistent-memory-api:8090). This is NOT NEXT_PUBLIC_API_URL (that is
 * the browser-facing host port, inlined at build, and is vestigial here because
 * the browser never calls the api directly).
 */

const BASE = process.env.API_URL ?? 'http://persistent-memory-api:8090'
const SHARED_MEMORY_BASE = process.env.PM_SHARED_API_URL?.replace(/\/$/, '') ?? ''
const SHARED_MEMORY_TOKEN = process.env.PM_SHARED_USER_TOKEN ?? ''
const MEMORY_INSTALL_MODE = process.env.PM_MEMORY_INSTALL_MODE ?? 'shared-only'

export function normalizeMemorySurface(value: unknown): MemorySurface {
  return value === 'shared' ? 'shared' : 'personal'
}

export async function configuredMemorySurfaces(): Promise<MemorySurface[]> {
  if (MEMORY_INSTALL_MODE === 'personal-and-shared') return ['personal', 'shared']
  if (MEMORY_INSTALL_MODE === 'shared-only') return ['shared']
  return ['personal', 'shared']
}

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}
export class ForbiddenError extends Error {
  constructor() {
    super('forbidden')
    this.name = 'ForbiddenError'
  }
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** The data-plane row uses `sourceTeam` for the team id; map it to `teamId`. */
function normalizeDp(r: Memory & { sourceTeam: string }): Memory {
  return { ...r, teamId: r.sourceTeam }
}

async function callAt<T>(base: string, path: string, init?: RequestInit, tokenOverride?: string | null): Promise<T> {
  const token = tokenOverride === undefined ? (await cookies()).get(SESSION_COOKIE)?.value : tokenOverride
  const headers = new Headers(init?.headers)
  if (init?.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers,
    // Control-plane data is per-request authed — never cache it.
    cache: 'no-store',
  })

  if (res.status === 401) throw new UnauthorizedError()
  if (res.status === 403) throw new ForbiddenError()
  if (!res.ok) {
    let code = 'api_error'
    let message = `${res.status}`
    let details: string | undefined
    try {
      const body = (await res.json()) as { error?: string; message?: string; reason?: string; details?: string }
      code = body.error ?? code
      message = body.message ?? body.reason ?? message
      details = body.details
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message, details)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  return callAt<T>(BASE, path, init)
}

async function sharedConnectionCredentials(): Promise<{ apiUrl: string; token: string } | null> {
  if (MEMORY_INSTALL_MODE === 'shared-only') return null
  const status = await call<SharedConnectionStatus>('/dashboard/shared-connection?includeToken=true').catch(() => null)
  if (status?.configured && status.apiUrl && status.token) {
    return { apiUrl: status.apiUrl.replace(/\/$/, ''), token: status.token }
  }
  if (SHARED_MEMORY_BASE && SHARED_MEMORY_TOKEN) {
    return { apiUrl: SHARED_MEMORY_BASE, token: SHARED_MEMORY_TOKEN }
  }
  return null
}

async function callMemory<T>(surface: MemorySurface, path: string, init?: RequestInit): Promise<T> {
  if (surface !== 'shared') return call<T>(path, init)
  if (MEMORY_INSTALL_MODE === 'shared-only') return call<T>(path, init)
  const connection = await sharedConnectionCredentials()
  if (!connection) {
    throw new ApiError(503, 'shared_surface_unconfigured', 'Shared memory surface is not configured.')
  }
  return callAt<T>(connection.apiUrl, path, init, connection.token)
}

/** Validate a raw token against /whoami WITHOUT touching the session cookie.
 * Used by the login action before a cookie exists. Returns null on 401. */
export async function whoamiWithToken(token: string): Promise<WhoAmI | null> {
  const res = await fetch(`${BASE}/whoami`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (res.status === 401) return null
  if (!res.ok) throw new ApiError(res.status, 'whoami_failed', `whoami → ${res.status}`)
  return (await res.json()) as WhoAmI
}

export const api = {
  getPublicConfig: () => call<PublicConfig>('/config'),
  passwordLogin: (email: string, password: string) =>
    call<PasswordLoginResult>('/auth/login/password', { method: 'POST', body: JSON.stringify({ email, password }) }),

  whoami: () => call<WhoAmI>('/whoami'),
  memoryWhoami: (surface: MemorySurface) => callMemory<WhoAmI>(surface, '/whoami'),

  // ── Overview dashboard ────────────────────────────────────────────────────
  getOverview: (surface: MemorySurface = 'personal') => callMemory<OverviewSummary>(surface, '/dashboard/overview'),

  // ── Distinct projects across the readable corpus (for filter dropdowns). ──────
  listProjects: () =>
    call<{ projects: { name: string }[] }>('/projects').then((r) => [...new Set(r.projects.map((p) => p.name))]),
  /** Projects WITH their source team — backs the team-scoped project dropdown (bulk delete). */
  listProjectScopes: (surface: MemorySurface = 'personal') =>
    callMemory<{ projects: { name: string; sourceTeam: string }[] }>(surface, '/projects').then((r) =>
      r.projects.map((p) => ({ name: p.name, teamId: p.sourceTeam })),
    ),

  // ── Self-service profile (P1) ────────────────────────────────────────────────
  getProfile: () => call<Profile>('/profile'),
  updateProfile: (b: { displayName?: string | null; email?: string | null; currentPassword?: string; password?: string; removePassword?: boolean }) =>
    call<Profile>('/profile', { method: 'PUT', body: JSON.stringify(b) }),

  // ── Local-mode dashboard password (P1, local installs only; public on the api) ─
  localAuthStatus: () => call<{ passwordSet: boolean }>('/local/auth'),
  localLogin: (password: string) =>
    call<{ ok: boolean }>('/local/auth', { method: 'POST', body: JSON.stringify({ password }) }),

  // ── Teams ──────────────────────────────────────────────────────────────────
  listTeams: (surface: MemorySurface = 'personal') => callMemory<{ teams: Team[] }>(surface, '/dashboard/teams').then((r) => r.teams),
  createTeam: (name: string) =>
    call<Team>('/dashboard/teams', { method: 'POST', body: JSON.stringify({ name }) }),
  renameTeam: (id: string, name: string) =>
    call<Team>(`/dashboard/teams/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteTeam: (id: string) =>
    call<void>(`/dashboard/teams/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }),

  // ── Users ──────────────────────────────────────────────────────────────────
  listUsers: (surface: MemorySurface = 'personal') => callMemory<{ users: User[] }>(surface, '/dashboard/users').then((r) => r.users),
  createUser: (b: { teamId: string; email?: string; displayName?: string }) =>
    call<User>('/dashboard/users', { method: 'POST', body: JSON.stringify(b) }),
  updateUser: (
    id: string,
    b: { teamId?: string | null; email?: string | null; displayName?: string | null },
  ) => call<User>(`/dashboard/users/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  /** Superuser-only on the server (requireSuperuser). */
  setAdminLevel: (id: string, adminLevel: AdminLevel) =>
    call<User>(`/dashboard/users/${id}/admin-level`, {
      method: 'PATCH',
      body: JSON.stringify({ adminLevel }),
    }),
  resetUserPassword: (id: string, password?: string) =>
    call<PasswordResetResult>(`/dashboard/users/${id}/password-reset`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
    }),
  deleteUser: (id: string) =>
    call<void>(`/dashboard/users/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }),

  // ── Tokens (show-once) ───────────────────────────────────────────────────────
  issueToken: (id: string, expiresAt?: string | null) =>
    call<IssuedToken>(`/dashboard/users/${id}/token`, {
      method: 'POST',
      body: JSON.stringify({ expiresAt: expiresAt ?? null }),
    }),
  rotateToken: (id: string, expiresAt?: string | null) =>
    call<IssuedToken>(`/dashboard/users/${id}/token/rotate`, {
      method: 'POST',
      body: JSON.stringify({ expiresAt: expiresAt ?? null }),
    }),
  revokeToken: (id: string) => call<void>(`/dashboard/users/${id}/token`, { method: 'DELETE' }),

  // ── Memories (dashboard plane: super → any team; team-admin → own team) ──────
  listMemories: (q: { teamId?: string; project?: string; category?: string; createdById?: string; cursor?: string; limit?: number; scoreMin?: number; scoreMax?: number }, surface: MemorySurface = 'personal') => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v))
    return callMemory<{ results: Memory[]; nextCursor: string | null; total: number; badges: string[] }>(surface, `/dashboard/memories?${params.toString()}`)
  },
  searchMemories: (b: { query: string; teamId?: string; project?: string; category?: string; scoreMin?: number; scoreMax?: number; limit?: number }, surface: MemorySurface = 'personal') =>
    callMemory<{ results: Memory[]; total: number }>(surface, '/dashboard/memories/search', { method: 'POST', body: JSON.stringify(b) }),
  getMemory: (id: string, surface: MemorySurface = 'personal') => callMemory<Memory>(surface, `/dashboard/memories/${id}`),
  updateMemory: (
    id: string,
    b: { content?: string; project?: string; category?: string; entities?: string[] },
    surface: MemorySurface = 'personal',
  ) => callMemory<Memory>(surface, `/dashboard/memories/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  previewMemoryDelete: (id: string, surface: MemorySurface = 'personal') =>
    callMemory<import('./types').GraphDeletePreview>(surface, `/dashboard/memories/${id}/delete-preview`, { method: 'POST' }),
  deleteMemory: (id: string, opts: { previewToken: string }, surface: MemorySurface = 'personal') =>
    callMemory<void>(surface, `/dashboard/memories/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(opts),
    }),
  pendingEmbeddings: (surface: MemorySurface = 'personal') => callMemory<PendingEmbeddings>(surface, '/dashboard/memories/pending'),
  rebuildMemoryGraph: (b: { teamId?: string; project?: string; createdById?: string }, surface: MemorySurface = 'personal') =>
    callMemory<MemoryGraphRebuildResult>(surface, '/dashboard/memories/graph/rebuild', { method: 'POST', body: JSON.stringify(b) }),
  exportMemories: (q: { teamId?: string; project?: string; createdById?: string } = {}, surface: MemorySurface = 'personal') => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v))
    const qs = params.toString()
    return callMemory<MemoryExportEnvelope>(surface, `/dashboard/memories/export${qs ? `?${qs}` : ''}`)
  },
  importMemories: (memories: unknown[], teamId?: string, project?: string, surface: MemorySurface = 'personal') =>
    callMemory<MemoryImportResult>(surface, '/dashboard/memories/import', {
      method: 'POST',
      body: JSON.stringify({ memories, ...(teamId ? { teamId } : {}), ...(project ? { project } : {}) }),
    }),

  // ── Memory Graph (metadata-safe, tenant-derived read model) ───────────────
  getMemoryGraphSnapshot: (
    q: MemoryGraphFilters & { cursor?: string; memoryLimit?: number; factLimit?: number },
    surface: MemorySurface = 'personal',
  ) => {
    const params = new URLSearchParams()
    for (const value of q.projects) params.append('projects', value)
    for (const value of q.tags) params.append('tags', value)
    for (const value of q.badges) params.append('badges', value)
    params.set('validity', q.validity)
    if (q.cursor) params.set('cursor', q.cursor)
    if (q.memoryLimit) params.set('memoryLimit', String(q.memoryLimit))
    if (q.factLimit) params.set('factLimit', String(q.factLimit))
    return callMemory<MemoryGraphSnapshot>(surface, `/graph/snapshot?${params.toString()}`)
  },
  getMemoryGraphFacets: (q: { search?: string; facet?: 'projects' | 'tags' | 'badges'; recent?: number } = {}, surface: MemorySurface = 'personal') => {
    const params = new URLSearchParams()
    if (q.search) params.set('search', q.search)
    if (q.facet) params.set('facet', q.facet)
    if (q.recent) params.set('recent', String(q.recent))
    return callMemory<MemoryGraphFacets>(surface, `/graph/facets?${params.toString()}`)
  },
  getMemoryGraphActivity: (
    q: MemoryGraphFilters & { cursor?: string },
    surface: MemorySurface = 'personal',
  ) => {
    const params = new URLSearchParams()
    for (const value of q.projects) params.append('projects', value)
    for (const value of q.tags) params.append('tags', value)
    for (const value of q.badges) params.append('badges', value)
    params.set('validity', q.validity)
    if (q.cursor) params.set('cursor', q.cursor)
    return callMemory<MemoryGraphActivityResult>(surface, `/graph/activity?${params.toString()}`)
  },

  // ── Mounts (directional cross-team MEMORY read links; gate the MCP) ───────────
  getGrants: () => call<GrantsMatrix>('/dashboard/grants'),
  setGrant: (grantorTeamId: string, granteeTeamId: string) =>
    call<Grant>('/dashboard/grants', {
      method: 'POST',
      body: JSON.stringify({ grantorTeamId, granteeTeamId }),
    }),
  unsetGrant: (grantorTeamId: string, granteeTeamId: string) =>
    call<void>('/dashboard/grants', {
      method: 'DELETE',
      body: JSON.stringify({ grantorTeamId, granteeTeamId }),
    }),

  // ── Local service monitor (Docker socket; mutate ops are superuser-only) ──────
  listServices: () => call<{ services: ServiceStatus[]; mcpClients: McpClientStatus[]; capabilityHealth: DashboardCapabilityHealth }>('/dashboard/services'),
  serviceAction: (service: string, action: 'start' | 'stop' | 'restart' | 'terminate') =>
    call<{ ok: boolean }>(`/dashboard/services/${encodeURIComponent(service)}/${action}`, { method: 'POST' }),
  serviceLogs: (service: string, tail = 200) =>
    call<{ service: string; logs: string }>(`/dashboard/services/${encodeURIComponent(service)}/logs?tail=${tail}`),
  mcpClientTerminate: (id: string) =>
    call<{ ok: boolean; reason?: string }>(`/dashboard/mcp-clients/${encodeURIComponent(id)}/terminate`, { method: 'POST' }),

  // ── Snapshot-safe updater (superuser-only) ────────────────────────────────
  updateStatus: () => call<UpdateStatus>('/dashboard/update'),
  updateLogs: () => call<UpdateLogState>('/dashboard/update/logs'),
  startUpdate: () => call<{ ok: boolean }>('/dashboard/update/start', { method: 'POST' }),
  getBrowserPushPublicKey: () => call<{ publicKey: string }>('/dashboard/browser-push/public-key'),
  saveBrowserPushSubscription: (b: BrowserPushSubscriptionInput) =>
    call<{ enabled: boolean; notificationTypes: BrowserPushNotificationType[] }>('/dashboard/browser-push/subscription', { method: 'PUT', body: JSON.stringify(b) }),
  deleteBrowserPushSubscription: (endpoint?: string) =>
    call<{ deleted: number }>('/dashboard/browser-push/subscription', { method: 'DELETE', body: JSON.stringify({ ...(endpoint ? { endpoint } : {}) }) }),
  updateBrowserPushPreferences: (notificationTypes: BrowserPushNotificationType[]) =>
    call<BrowserPushPreferencesResult>('/dashboard/browser-push/preferences', { method: 'PATCH', body: JSON.stringify({ notificationTypes }) }),
  sendBrowserPushTest: () => call<BrowserPushSendResult>('/dashboard/browser-push/test', { method: 'POST' }),
  notifyBrowserPush: (b: { type: BrowserPushNotificationType; title: string; body?: string; url?: string; tag?: string }) =>
    call<BrowserPushSendResult>('/dashboard/browser-push/notify', { method: 'POST', body: JSON.stringify(b) }),

  // ── Managed scheduled workers (reads any-auth; mutate ops superuser-only) ─────
  listWorkers: () => call<{ workers: WorkerStatus[]; liveness: WorkerLiveness }>('/dashboard/workers'),
  workerLogs: (name: string) => call<WorkerLog>(`/dashboard/workers/${encodeURIComponent(name)}/logs`),
  workerAction: (name: string, action: WorkerAction) =>
    call<{ ok: boolean }>(`/dashboard/workers/${encodeURIComponent(name)}/${action}`, { method: 'POST' }),
  editWorker: (name: string, body: { cron?: string; enabled?: boolean }) =>
    call<{ ok: boolean }>(`/dashboard/workers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // ── Data-plane memories (/memories/*) — for a PLAIN MEMBER (not admin+). The
  //    data-plane row uses `sourceTeam`; we normalize it to `teamId` here. ───────
  dpListMemories: (q: { project?: string; category?: string; cursor?: string; limit?: number; scoreMin?: number; scoreMax?: number }, surface: MemorySurface = 'personal') => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v))
    // Dashboard reads are universal for any member (users_roles.md); the MCP omits this.
    params.set('universal', 'true')
    return callMemory<{ results: (Memory & { sourceTeam: string })[]; nextCursor: string | null; total: number; badges: string[] }>(
      surface,
      `/memories?${params.toString()}`,
    ).then((r) => ({ results: r.results.map(normalizeDp), nextCursor: r.nextCursor, total: r.total, badges: r.badges }))
  },
  dpSearchMemories: (b: { query: string; project?: string; category?: string; scoreMin?: number; scoreMax?: number; limit?: number }, surface: MemorySurface = 'personal') =>
    callMemory<{ results: (Memory & { sourceTeam: string })[] }>(surface, '/memories/search', {
      method: 'POST',
      body: JSON.stringify({ ...b, universal: true }),
    }).then((r) => ({ results: r.results.map(normalizeDp) })),
  dpUpdateMemory: (id: string, b: { content?: string; project?: string }, surface: MemorySurface = 'personal') =>
    callMemory<Memory & { sourceTeam: string }>(surface, `/memories/${id}`, { method: 'PATCH', body: JSON.stringify(b) }).then(normalizeDp),
  dpDeleteMemory: (id: string, surface: MemorySurface = 'personal') => callMemory<void>(surface, `/memories/${id}`, { method: 'DELETE' }),
  dpPreviewBulkDeleteMemories: (project?: string, surface: MemorySurface = 'personal') =>
    callMemory<import('./types').BulkGraphDeletePreview>(surface, '/memories/bulk-delete-preview', {
      method: 'POST',
      body: JSON.stringify(project ? { project } : {}),
    }),
  dpConfirmBulkDeleteMemories: (previewToken: string, surface: MemorySurface = 'personal') =>
    callMemory<{ deleted: number }>(surface, '/memories/bulk', {
      method: 'DELETE',
      body: JSON.stringify({ previewToken }),
    }),
  // ── System Settings ────────────────────────────────────────────────────────
  getSettings: () => call<Settings>('/dashboard/settings'),
  /** Superuser-only on the server (requireSuperuser). */
  putSettings: (b: {
    embeddingMode: EmbeddingMode
    activeEmbedModel: string
    activeEmbedDim: number
  }) => call<SettingsUpdateResult>('/dashboard/settings', { method: 'PUT', body: JSON.stringify(b) }),
  testEmbedding: (b: { activeEmbedModel: string; activeEmbedDim: number }) =>
    call<SettingsTestResult>('/dashboard/settings/embedding/test', { method: 'POST', body: JSON.stringify(b) }),
  testFactExtraction: (b: { model: string; apiKey?: string }) =>
    call<SettingsTestResult>('/dashboard/settings/fact-extraction/test', { method: 'POST', body: JSON.stringify(b) }),
  putFactExtraction: (b: { model: string; apiKey?: string }) =>
    call<Settings>('/dashboard/settings/fact-extraction', { method: 'PUT', body: JSON.stringify(b) }),
  putMcpSessionTimeout: (b: { mcpSessionIdleTimeoutSeconds: number }) =>
    call<Settings>('/dashboard/settings/mcp-session-timeout', { method: 'PUT', body: JSON.stringify(b) }),
  putDashboardLoginMode: (mode: DashboardLoginMode) =>
    call<Settings>('/dashboard/settings/dashboard-login', { method: 'PUT', body: JSON.stringify({ mode }) }),
  getSharedConnection: () => call<SharedConnectionStatus>('/dashboard/shared-connection'),
  testSharedConnection: (b: { apiUrl: string; token: string }) =>
    call<SharedConnectionTestResult>('/dashboard/shared-connection/test', { method: 'POST', body: JSON.stringify(b) }),
  saveSharedConnection: (b: { apiUrl: string; token: string }) =>
    call<SharedConnectionStatus>('/dashboard/shared-connection', { method: 'PUT', body: JSON.stringify(b) }),
  disconnectSharedConnection: () =>
    call<SharedConnectionStatus>('/dashboard/shared-connection', { method: 'DELETE' }),

  // ── Usage metrics ──────────────────────────────────────────────────────────
  getUsage: (window: UsageWindow, surface: MemorySurface = 'personal') =>
    callMemory<UsageResponse>(surface, `/dashboard/usage?window=${window}`),

  // ── Security (DLP/PII alerts) — admin+ reads own-team / super sees all ───────
  getSecurityAlerts: (q?: { resolved?: boolean; severity?: string }, surface: MemorySurface = 'personal') => {
    const p = new URLSearchParams()
    if (q?.resolved !== undefined) p.set('resolved', String(q.resolved))
    if (q?.severity) p.set('severity', q.severity)
    const qs = p.toString()
    return callMemory<{ alerts: SecurityAlert[] }>(surface, `/dashboard/security-alerts${qs ? `?${qs}` : ''}`)
  },
  getSecurityAlertCount: (surface: MemorySurface = 'personal') =>
    callMemory<{ open: number; high: number }>(surface, '/dashboard/security-alerts/count'),
  resolveSecurityAlert: (id: string, surface: MemorySurface = 'personal') =>
    callMemory<{ ok: boolean }>(surface, `/dashboard/security-alerts/${id}/resolve`, { method: 'POST' }),

  // ── Notification settings (per-team + global super-admin row) ────────────────
  getNotifySettings: (teamId?: string, surface: MemorySurface = 'personal') =>
    callMemory<{ team: NotifySettings | null; global: NotifySettings | null }>(surface, `/dashboard/notify-settings${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`),
  putNotifySettings: (b: NotifySettingsInput, teamId?: string, surface: MemorySurface = 'personal') =>
    callMemory<NotifySettings>(surface, `/dashboard/notify-settings${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`, { method: 'PUT', body: JSON.stringify(b) }),
  /** Superuser-only on the server. */
  putGlobalNotifySettings: (b: NotifySettingsInput, surface: MemorySurface = 'personal') =>
    callMemory<NotifySettings>(surface, '/dashboard/notify-settings/global', { method: 'PUT', body: JSON.stringify(b) }),
}
