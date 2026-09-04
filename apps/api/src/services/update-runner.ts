/**
 * API-side client for the restricted update-runner sidecar.
 *
 * The browser never calls the sidecar directly. The API presents
 * UPDATE_RUNNER_TOKEN over the internal Compose network, and /dashboard/update routes
 * enforce dashboard RBAC around these calls.
 */
import { config } from '../config.ts'

export interface ServiceRelease {
  service: string
  version: string
  change: string
}

export interface ReleaseNotes {
  version: string
  date: string
  latest: boolean
  services: ServiceRelease[]
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
}

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
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

export class UpdateRunnerUnavailableError extends Error {
  readonly statusCode = 503 as const
  readonly code = 'update_runner_unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'UpdateRunnerUnavailableError'
  }
}

export class UpdateRunnerRequestError extends Error {
  constructor(
    readonly statusCode: 422 | 500,
    readonly code: string,
    message: string,
    readonly details?: string,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'UpdateRunnerRequestError'
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!config.UPDATE_RUNNER_TOKEN) {
    throw new UpdateRunnerUnavailableError('Update runner disabled — UPDATE_RUNNER_TOKEN is not set.')
  }
  let res: Response
  try {
    res = await fetch(`${config.UPDATE_RUNNER_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.UPDATE_RUNNER_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new UpdateRunnerUnavailableError(
      `update-runner unreachable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) {
    let body: { error?: string; message?: string; details?: string; requestId?: string } = {}
    try {
      body = await res.json() as typeof body
    } catch {
      // A sidecar restart can produce a non-JSON error body.
    }
    if ((res.status === 422 || res.status === 500) && body.error && body.message) {
      throw new UpdateRunnerRequestError(res.status, body.error, body.message, body.details, body.requestId)
    }
    throw new UpdateRunnerUnavailableError(body.message ?? `update-runner returned ${res.status}.`)
  }
  return (await res.json()) as T
}

export function getUpdateStatus(): Promise<UpdateStatus> {
  return call<UpdateStatus>('GET', '/status')
}

export function getUpdateLogs(): Promise<UpdateLogState> {
  return call<UpdateLogState>('GET', '/logs')
}

export function startUpdate(): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('POST', '/start')
}

export function getUpdateSettings(): Promise<UpdateNotificationSettings> {
  return call<UpdateNotificationSettings>('GET', '/settings')
}

export function saveUpdateSettings(input: UpdateNotificationSettingsInput): Promise<UpdateNotificationSettings> {
  return call<UpdateNotificationSettings>('PATCH', '/settings', input)
}

export function testUpdateSettings(input: UpdateNotificationSettingsInput): Promise<UpdateConnectionTestResult> {
  return call<UpdateConnectionTestResult>('POST', '/test', input)
}
