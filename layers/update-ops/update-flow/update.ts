import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { compareSemver, detectMcpRestartRequired, parseReleaseHistory, type ParsedRelease } from '../release-versioning/release.js'

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  updateBranch?: string
  autoUpdateReady?: boolean
  currentCommit?: string
  latestCommit?: string
  releaseNotes?: ParsedRelease | null
  mcpRestartRequired?: boolean
  running: boolean
  lastRun?: UpdateRunSummary
  lastSuccessfulUpdate?: PostUpdateSignal
  logs: string[]
}

export interface UpdateRunSummary {
  ok: boolean
  startedAt: string
  finishedAt?: string
  backupPath?: string
  error?: string
}

export interface UpdateLogState {
  running: boolean
  logs: string[]
  lastRun?: UpdateRunSummary
}

export interface PostUpdateSignal {
  id: string
  source: 'update-script' | 'update-runner'
  version: string
  finishedAt: string
  branch?: string
  commit?: string
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

export type UpdateRunnerErrorCode = 'update_settings_invalid' | 'bitbucket_connection_failed' | 'runtime_env_unavailable'

export class UpdateRunnerError extends Error {
  readonly code: UpdateRunnerErrorCode
  readonly details: string
  readonly statusCode: number

  constructor(
    code: UpdateRunnerErrorCode,
    message: string,
    details: string,
    statusCode = 422,
  ) {
    super(message)
    this.name = 'UpdateRunnerError'
    this.code = code
    this.details = details
    this.statusCode = statusCode
  }
}

export interface RunnerConfig {
  repoDir: string
  backupRoot: string
  branch: string
}

type ExecResult = { code: number; stdout: string; stderr: string }
type RuntimeEnv = Record<string, string>
type RemoteMetadata = {
  latestVersion: string | null
  latestCommit?: string
  releaseNotes?: ParsedRelease | null
  changedPaths?: string[]
  autoUpdateReady: boolean
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => {
      const s = b.toString()
      stdout += s
      options.onLog?.(s)
    })
    child.stderr.on('data', (b: Buffer) => {
      const s = b.toString()
      stderr += s
      options.onLog?.(s)
    })
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function execChecked(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void },
): Promise<string> {
  const r = await runCommand(command, args, options)
  if (r.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`.trim())
  }
  return r.stdout
}

function gitArgs(repoDir: string, args: string[]): string[] {
  return ['-c', `safe.directory=${repoDir}`, ...args]
}

function isHttpRemoteUrl(remoteUrl: string): boolean {
  return /^https?:\/\//iu.test(remoteUrl)
}

function remoteUsernameFromUrl(remoteUrl: string): string {
  try {
    return new URL(remoteUrl).username
  } catch {
    return ''
  }
}

async function gitFetchAuthEnv(repoDir: string, runtimeEnv: RuntimeEnv): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const baseEnv: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }
  let remoteUrl = ''
  try {
    remoteUrl = (await execChecked('git', gitArgs(repoDir, ['remote', 'get-url', 'origin']), { cwd: repoDir, env: baseEnv })).trim()
  } catch {
    return { env: baseEnv, cleanup: async () => {} }
  }

  const token = envValue(runtimeEnv, 'UPDATE_BITBUCKET_TOKEN')
  if (envValue(runtimeEnv, 'UPDATE_CHECK_PROVIDER') !== 'bitbucket' || !token || !isHttpRemoteUrl(remoteUrl)) {
    return { env: baseEnv, cleanup: async () => {} }
  }

  const username = envValue(runtimeEnv, 'UPDATE_BITBUCKET_USER') || remoteUsernameFromUrl(remoteUrl) || process.env.USER || 'git'
  const dir = await mkdtemp(join(tmpdir(), 'pm-git-askpass-'))
  const askpass = join(dir, 'askpass.sh')
  await writeFile(askpass, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  *Username*) printf \'%s\\n\' "$PM_GIT_USERNAME" ;;',
    '  *Password*) printf \'%s\\n\' "$PM_GIT_PASSWORD" ;;',
    '  *) printf \'%s\\n\' "$PM_GIT_PASSWORD" ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 })

  return {
    env: {
      ...baseEnv,
      GIT_ASKPASS: askpass,
      PM_GIT_USERNAME: username,
      PM_GIT_PASSWORD: token,
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function readPackageVersion(repoDir: string): Promise<string> {
  const raw = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8')) as { version?: string }
  return raw.version ?? '0.0.0'
}

async function readCurrentVersion(repoDir: string): Promise<string> {
  const packageVersion = await readPackageVersion(repoDir)
  const deployedHistoryUrl = process.env.UPDATE_DEPLOYED_RELEASE_HISTORY_URL ?? 'http://dashboard:3000/release-history.md'
  try {
    const res = await fetch(deployedHistoryUrl)
    if (!res.ok) throw new Error(`deployed release history returned ${res.status}`)
    return parseReleaseHistory(await res.text())[0]?.version ?? packageVersion
  } catch {
    return packageVersion
  }
}

const POST_UPDATE_SIGNAL_PATH = ['.local', 'update-state', 'last-successful-update.json'] as const

function isPostUpdateSignal(value: unknown): value is PostUpdateSignal {
  const input = value as Partial<PostUpdateSignal> | null
  return Boolean(
    input
      && typeof input.id === 'string'
      && (input.source === 'update-script' || input.source === 'update-runner')
      && typeof input.version === 'string'
      && typeof input.finishedAt === 'string'
      && (input.branch == null || typeof input.branch === 'string')
      && (input.commit == null || typeof input.commit === 'string'),
  )
}

async function readPostUpdateSignal(repoDir: string): Promise<PostUpdateSignal | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(repoDir, ...POST_UPDATE_SIGNAL_PATH), 'utf8')) as unknown
    return isPostUpdateSignal(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function readGitRef(repoDir: string, args: string[]): Promise<string | undefined> {
  try {
    return (await execChecked('git', gitArgs(repoDir, args), { cwd: repoDir })).trim() || undefined
  } catch {
    return undefined
  }
}

function sameGitCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

async function writePostUpdateSignal(
  repoDir: string,
  version: string,
  source: PostUpdateSignal['source'],
  branch?: string,
): Promise<PostUpdateSignal> {
  const finishedAt = new Date().toISOString()
  const commit = await readGitRef(repoDir, ['rev-parse', 'HEAD'])
  const resolvedBranch = branch || await readGitRef(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const signal: PostUpdateSignal = {
    id: `${finishedAt}-${version}`,
    source,
    version,
    finishedAt,
  }
  if (resolvedBranch && resolvedBranch !== 'HEAD') signal.branch = resolvedBranch
  if (commit) signal.commit = commit
  const stateDir = join(repoDir, '.local', 'update-state')
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, 'last-successful-update.json'), `${JSON.stringify(signal, null, 2)}\n`, { mode: 0o600 })
  return signal
}

function parseEnv(raw: string): RuntimeEnv {
  const out: RuntimeEnv = {}
  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const UPDATE_ENV_KEYS = [
  'UPDATE_CHECK_PROVIDER',
  'UPDATE_BITBUCKET_URL',
  'UPDATE_BITBUCKET_TOKEN',
  'UPDATE_BITBUCKET_SCOPE',
  'UPDATE_BITBUCKET_PROJECT',
  'UPDATE_BITBUCKET_USER',
  'UPDATE_BITBUCKET_REPO',
  'UPDATE_BITBUCKET_BRANCH',
] as const

async function readRuntimeEnv(repoDir: string): Promise<RuntimeEnv> {
  const envPath = join(repoDir, '.env.persistent-memory')
  if (!existsSync(envPath)) return {}
  return parseEnv(await readFile(envPath, 'utf8'))
}

function cleanEnvValue(value: string | undefined): string {
  return (value ?? '').replace(/\r?\n/gu, '').trim()
}

async function writeRuntimeEnv(repoDir: string, updates: Partial<Record<(typeof UPDATE_ENV_KEYS)[number], string>>): Promise<void> {
  const envPath = join(repoDir, '.env.persistent-memory')
  const raw = existsSync(envPath) ? await readFile(envPath, 'utf8') : ''
  const seen = new Set<string>()
  const lines = raw ? raw.split(/\r?\n/u) : []
  const nextLines = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/u)
    if (!match) return line
    const key = match[2] as (typeof UPDATE_ENV_KEYS)[number]
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line
    seen.add(key)
    return `${match[1]}${key}=${cleanEnvValue(updates[key])}`
  })

  const missing = UPDATE_ENV_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(updates, key) && !seen.has(key))
  let next = nextLines.join('\n')
  if (next && !next.endsWith('\n')) next += '\n'
  if (missing.length > 0) {
    if (next.trim()) next += '\n'
    next += '# Application update notifications\n'
    next += `${missing.map((key) => `${key}=${cleanEnvValue(updates[key])}`).join('\n')}\n`
  }
  await writeFile(envPath, next, { mode: 0o600 })
}

function envValue(env: RuntimeEnv, key: string): string {
  return (env[key] ?? process.env[key] ?? '').trim()
}

function providerFromEnv(value: string): UpdateSettingsProvider {
  if (value === 'bitbucket' || value === 'git') return value
  return 'none'
}

function scopeFromEnv(value: string): UpdateBitbucketScope {
  return value === 'user' ? 'user' : 'project'
}

function settingsFromEnv(env: RuntimeEnv, branchFallback: string): UpdateNotificationSettings {
  const provider = providerFromEnv(envValue(env, 'UPDATE_CHECK_PROVIDER'))
  return {
    enabled: provider !== 'none',
    provider,
    bitbucket: {
      url: envValue(env, 'UPDATE_BITBUCKET_URL'),
      tokenConfigured: Boolean(envValue(env, 'UPDATE_BITBUCKET_TOKEN')),
      scope: scopeFromEnv(envValue(env, 'UPDATE_BITBUCKET_SCOPE')),
      project: envValue(env, 'UPDATE_BITBUCKET_PROJECT'),
      user: envValue(env, 'UPDATE_BITBUCKET_USER'),
      repo: envValue(env, 'UPDATE_BITBUCKET_REPO'),
      branch: envValue(env, 'UPDATE_BITBUCKET_BRANCH') || branchFallback,
    },
  }
}

export function updateNotificationSettingsBackup(env: RuntimeEnv, branchFallback: string): UpdateNotificationSettings & { note: string } {
  return {
    ...settingsFromEnv(env, branchFallback),
    note: 'Bitbucket token is redacted here; the raw value is preserved in the .env.persistent-memory snapshot.',
  }
}

function requireEnabledBitbucketSettings(values: Record<string, string>): void {
  if (values.UPDATE_CHECK_PROVIDER !== 'bitbucket') return
  const scope = scopeFromEnv(values.UPDATE_BITBUCKET_SCOPE ?? '')
  const missing: string[] = []
  if (!values.UPDATE_BITBUCKET_URL) missing.push('Bitbucket URL')
  if (!values.UPDATE_BITBUCKET_TOKEN) missing.push('Bitbucket token')
  if (scope === 'user' && !values.UPDATE_BITBUCKET_USER) missing.push('Bitbucket user')
  if (scope === 'project' && !values.UPDATE_BITBUCKET_PROJECT) missing.push('Bitbucket project')
  if (!values.UPDATE_BITBUCKET_REPO) missing.push('Bitbucket repo')
  if (!values.UPDATE_BITBUCKET_BRANCH) missing.push('Bitbucket branch')
  if (missing.length > 0) {
    throw new UpdateRunnerError(
      'update_settings_invalid',
      `Missing required update notification setting${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
      'Complete the highlighted Bitbucket fields before saving or testing the connection.',
    )
  }
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/')
}

async function fetchText(url: string, token: string): Promise<string> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? 'Check that the personal access token can read this repository.'
      : res.status === 404
        ? 'Check the repository owner, repository name, and branch.'
        : 'Check the Bitbucket URL, VPN connection, and server availability.'
    throw new UpdateRunnerError(
      'bitbucket_connection_failed',
      `Bitbucket returned HTTP ${res.status} while checking the update source.`,
      hint,
    )
  }
  return res.text()
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const raw = await fetchText(url, token)
  return JSON.parse(raw) as T
}

async function readBitbucketMetadata(env: RuntimeEnv, branchFallback: string): Promise<RemoteMetadata | null> {
  const baseUrl = envValue(env, 'UPDATE_BITBUCKET_URL').replace(/\/+$/u, '')
  const token = envValue(env, 'UPDATE_BITBUCKET_TOKEN')
  const scope = envValue(env, 'UPDATE_BITBUCKET_SCOPE') || 'project'
  const project = envValue(env, 'UPDATE_BITBUCKET_PROJECT')
  const user = envValue(env, 'UPDATE_BITBUCKET_USER')
  const repo = envValue(env, 'UPDATE_BITBUCKET_REPO')
  const branch = envValue(env, 'UPDATE_BITBUCKET_BRANCH') || branchFallback
  const owner = scope === 'user' ? user : project
  if (!baseUrl || !token || !owner || !repo || !branch) return null

  const ownerPath = scope === 'user'
    ? `users/${encodeURIComponent(user)}`
    : `projects/${encodeURIComponent(project)}`
  const repoBase = `${baseUrl}/rest/api/1.0/${ownerPath}/repos/${encodeURIComponent(repo)}`
  const at = `refs/heads/${branch}`
  const commitsUrl = `${repoBase}/commits?${new URLSearchParams({ until: at, limit: '1' }).toString()}`
  const commits = await fetchJson<{ values?: { id?: string }[] }>(commitsUrl, token)
  const latestCommit = commits.values?.[0]?.id

  const rawUrl = (path: string): string => `${repoBase}/raw/${encodePath(path)}?${new URLSearchParams({ at }).toString()}`
  const remotePackage = JSON.parse(await fetchText(rawUrl('package.json'), token)) as { version?: string }
  const remoteHistory = await fetchText(rawUrl('release-history.md'), token)
  return {
    latestVersion: remotePackage.version ?? null,
    latestCommit,
    releaseNotes: parseReleaseHistory(remoteHistory)[0] ?? null,
    changedPaths: [],
    autoUpdateReady: false,
  }
}

function updateSettingsValues(
  input: UpdateNotificationSettingsInput,
  currentEnv: RuntimeEnv,
  current: UpdateNotificationSettings,
  branchFallback: string,
): Record<string, string> {
  const bitbucket = input.bitbucket ?? {}
  const scope = scopeFromEnv(bitbucket.scope ?? current.bitbucket.scope)
  const token = cleanEnvValue(bitbucket.token)
  return {
    UPDATE_CHECK_PROVIDER: input.enabled ? 'bitbucket' : 'none',
    UPDATE_BITBUCKET_URL: cleanEnvValue(bitbucket.url ?? current.bitbucket.url),
    UPDATE_BITBUCKET_TOKEN: token || envValue(currentEnv, 'UPDATE_BITBUCKET_TOKEN'),
    UPDATE_BITBUCKET_SCOPE: scope,
    UPDATE_BITBUCKET_PROJECT: cleanEnvValue(bitbucket.project ?? current.bitbucket.project),
    UPDATE_BITBUCKET_USER: cleanEnvValue(bitbucket.user ?? current.bitbucket.user),
    UPDATE_BITBUCKET_REPO: cleanEnvValue(bitbucket.repo ?? current.bitbucket.repo),
    UPDATE_BITBUCKET_BRANCH: cleanEnvValue(bitbucket.branch ?? current.bitbucket.branch) || branchFallback,
  }
}

async function readGitMetadata(repoDir: string, branch: string, runtimeEnv: RuntimeEnv = {}): Promise<RemoteMetadata> {
  const auth = await gitFetchAuthEnv(repoDir, runtimeEnv)
  try {
    await execChecked('git', gitArgs(repoDir, ['fetch', '--quiet', 'origin', branch]), { cwd: repoDir, env: auth.env })
    const latestCommit = (await execChecked('git', gitArgs(repoDir, ['rev-parse', `origin/${branch}`]), { cwd: repoDir })).trim()
    const remotePackage = JSON.parse(
      await execChecked('git', gitArgs(repoDir, ['show', `origin/${branch}:package.json`]), { cwd: repoDir }),
    ) as { version?: string }
    const remoteHistory = await execChecked('git', gitArgs(repoDir, ['show', `origin/${branch}:release-history.md`]), { cwd: repoDir })
    const changedPaths = (await execChecked('git', gitArgs(repoDir, ['diff', '--name-only', `HEAD..origin/${branch}`]), { cwd: repoDir }))
      .split(/\r?\n/u)
      .filter(Boolean)
    return {
      latestVersion: remotePackage.version ?? null,
      latestCommit,
      releaseNotes: parseReleaseHistory(remoteHistory)[0] ?? null,
      changedPaths,
      autoUpdateReady: true,
    }
  } finally {
    await auth.cleanup()
  }
}

function composeArgs(runtimeEnv: RuntimeEnv, args: string[]): string[] {
  const base = ['compose', '-f', 'deploy/compose/docker-compose.yml', '--env-file', '.env.persistent-memory']
  if ((runtimeEnv.PM_MCP_RUNTIME ?? 'node') === 'stream') {
    base.push('--profile', 'mcp-stream')
  }
  return [...base, ...args]
}

export function runtimeServices(runtimeEnv: RuntimeEnv): string[] {
  const services = [
    'api',
    'dashboard',
    'documentation',
    'dashboard-gateway',
    'worker',
    'docker-control',
    'graphiti',
    'dlp',
  ]
  if ((runtimeEnv.PM_MCP_RUNTIME ?? 'node') === 'stream') {
    services.push('mcp')
  }
  return services
}

async function createSnapshot(cfg: RunnerConfig, onLog: (line: string) => void): Promise<string> {
  const backupPath = join(cfg.backupRoot, nowStamp())
  await mkdir(backupPath, { recursive: true })
  const manifest = {
    createdAt: new Date().toISOString(),
    repoDir: cfg.repoDir,
    branch: cfg.branch,
    includes: [
      '.env.persistent-memory',
      'redacted update notification settings',
      'postgres pg_dump when available',
      'read-only mounted volume archives for qdrant, falkordb, redis, minio, postgres, neo4j when mounted',
      'compose service inventory',
    ],
  }
  await writeFile(join(backupPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  if (existsSync(join(cfg.repoDir, '.env.persistent-memory'))) {
    await execChecked('cp', ['.env.persistent-memory', join(backupPath, '.env.persistent-memory')], { cwd: cfg.repoDir, onLog })
    await writeFile(
      join(backupPath, 'update-notification-settings.json'),
      `${JSON.stringify(updateNotificationSettingsBackup(await readRuntimeEnv(cfg.repoDir), cfg.branch), null, 2)}\n`,
      { mode: 0o600 },
    )
  }
  const ps = await runCommand('docker', ['compose', '-f', 'deploy/compose/docker-compose.yml', '--env-file', '.env.persistent-memory', 'ps'], {
    cwd: cfg.repoDir,
    onLog: (line) => onLog(`[compose ps] ${line}`),
  })
  await writeFile(join(backupPath, 'compose-ps.txt'), ps.stdout || ps.stderr || '', { mode: 0o600 })

  const dump = await runCommand('docker', ['compose', '-f', 'deploy/compose/docker-compose.yml', '--env-file', '.env.persistent-memory', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'pmuser', 'persistent_memory'], {
    cwd: cfg.repoDir,
    onLog: (line) => onLog(`[postgres dump] ${line}`),
  })
  if (dump.code === 0 && dump.stdout) {
    await writeFile(join(backupPath, 'postgres.sql'), dump.stdout, { mode: 0o600 })
  } else {
    await writeFile(join(backupPath, 'postgres-dump-error.txt'), dump.stderr || dump.stdout || 'pg_dump did not return output', { mode: 0o600 })
  }

  const mounts = [
    ['qdrant', '/snapshot/qdrant'],
    ['falkordb', '/snapshot/falkordb'],
    ['neo4j', '/snapshot/neo4j'],
    ['postgres-volume', '/snapshot/postgres'],
    ['redis', '/snapshot/redis'],
    ['minio', '/snapshot/minio'],
  ] as const
  for (const [name, path] of mounts) {
    if (!existsSync(path)) continue
    const result = await runCommand('tar', ['-czf', join(backupPath, `${name}.tgz`), '-C', path, '.'], {
      cwd: cfg.repoDir,
      onLog: (line) => onLog(`[snapshot ${name}] ${line}`),
    })
    if (result.code !== 0) {
      await writeFile(join(backupPath, `${name}-error.txt`), result.stderr || result.stdout, { mode: 0o600 })
    }
  }

  await writeFile(join(backupPath, 'mcp-config-report.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Restart Claude/Codex when release notes or changed paths report MCP changes.',
  }, null, 2)}\n`, { mode: 0o600 })
  onLog(`Snapshot manifest written to ${backupPath}\n`)
  return backupPath
}

export function createUpdateRunner(cfg: RunnerConfig) {
  let running = false
  let logs: string[] = []
  let lastRun: UpdateRunSummary | undefined

  const push = (line: string): void => {
    for (const part of line.split(/\r?\n/u)) {
      if (!part) continue
      logs = [...logs.slice(-499), part]
    }
  }

  const status = async (): Promise<UpdateStatus> => {
    const currentVersion = await readCurrentVersion(cfg.repoDir)
    let latestVersion: string | null = null
    let releaseNotes: ParsedRelease | null = null
    let currentCommit: string | undefined
    let latestCommit: string | undefined
    let changedPaths: string[] = []
    let autoUpdateReady = false
    const runtimeEnv = await readRuntimeEnv(cfg.repoDir)
    const updateSettings = settingsFromEnv(runtimeEnv, cfg.branch)
    const updateBranch = updateSettings.bitbucket.branch || cfg.branch
    const lastSuccessfulUpdate = await readPostUpdateSignal(cfg.repoDir)
    try {
      currentCommit = (await execChecked('git', gitArgs(cfg.repoDir, ['rev-parse', 'HEAD']), { cwd: cfg.repoDir })).trim()
    } catch (err) {
      // currentCommit is best-effort only.
    }
    try {
      const provider = envValue(runtimeEnv, 'UPDATE_CHECK_PROVIDER') || 'none'
      const metadata = provider === 'bitbucket'
        ? await readBitbucketMetadata(runtimeEnv, cfg.branch)
        : provider === 'git'
          ? await readGitMetadata(cfg.repoDir, updateBranch, runtimeEnv)
          : null
      if (metadata) {
        latestVersion = metadata.latestVersion
        latestCommit = metadata.latestCommit
        releaseNotes = metadata.releaseNotes ?? null
        changedPaths = metadata.changedPaths ?? []
        autoUpdateReady = metadata.autoUpdateReady
      }
    } catch (err) {
      // Status polling is intentionally quiet: if Git/VPN/auth metadata is not
      // available, the dashboard simply behaves as if no newer version is known.
    }
    const releaseUpdateAvailable = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0)
    const deployedCommit = lastSuccessfulUpdate?.branch === updateBranch ? lastSuccessfulUpdate.commit : undefined
    const branchCommitUpdateAvailable = updateBranch !== 'master'
      && Boolean(latestCommit)
      && (!deployedCommit || !sameGitCommit(deployedCommit, latestCommit))

    return {
      currentVersion,
      latestVersion,
      updateAvailable: releaseUpdateAvailable || branchCommitUpdateAvailable,
      updateBranch,
      autoUpdateReady,
      currentCommit,
      latestCommit,
      releaseNotes,
      mcpRestartRequired: releaseNotes?.mcpRestartRequired || detectMcpRestartRequired(changedPaths),
      running,
      lastRun,
      lastSuccessfulUpdate,
      logs,
    }
  }

  const start = async (): Promise<{ ok: boolean }> => {
    if (running) return { ok: false }
    running = true
    logs = []
    lastRun = { ok: false, startedAt: new Date().toISOString() }
    void (async () => {
      try {
        push('Starting snapshot-safe update')
        const backupPath = await createSnapshot(cfg, push)
        const runtimeEnv = await readRuntimeEnv(cfg.repoDir)
        const databaseMigrateUrl = runtimeEnv.DATABASE_MIGRATE_URL ?? process.env.DATABASE_MIGRATE_URL ?? ''
        if (!databaseMigrateUrl) {
          throw new Error('DATABASE_MIGRATE_URL is missing in .env.persistent-memory; cannot run migrations safely')
        }
        lastRun = { ...lastRun!, backupPath }
        const auth = await gitFetchAuthEnv(cfg.repoDir, runtimeEnv)
        const updateSettings = settingsFromEnv(runtimeEnv, cfg.branch)
        const updateBranch = updateSettings.bitbucket.branch || cfg.branch
        try {
          await execChecked('git', gitArgs(cfg.repoDir, ['fetch', '--quiet', 'origin', updateBranch]), { cwd: cfg.repoDir, env: auth.env, onLog: push })
        } catch (err) {
          push(`git fetch failed; using cached origin/${updateBranch} if available: ${err instanceof Error ? err.message : String(err)}`)
          await execChecked('git', gitArgs(cfg.repoDir, ['rev-parse', `origin/${updateBranch}`]), { cwd: cfg.repoDir, onLog: push })
        } finally {
          await auth.cleanup()
        }
        await execChecked('git', gitArgs(cfg.repoDir, ['merge', '--ff-only', `origin/${updateBranch}`]), { cwd: cfg.repoDir, onLog: push })
        const services = runtimeServices(runtimeEnv)
        await execChecked('docker', composeArgs(runtimeEnv, ['up', '-d', '--build', ...services]), {
          cwd: cfg.repoDir,
          env: { COMPOSE_PARALLEL_LIMIT: process.env.COMPOSE_PARALLEL_LIMIT ?? '1' },
          onLog: push,
        })
        await execChecked(process.env.PRISMA_BIN ?? '/app/node_modules/.bin/prisma', ['migrate', 'deploy'], {
          cwd: join(cfg.repoDir, 'layers/core/schema'),
          env: {
            DATABASE_MIGRATE_URL: databaseMigrateUrl,
            NODE_PATH: process.env.NODE_PATH ? `${process.env.NODE_PATH}:/app/node_modules` : '/app/node_modules',
          },
          onLog: push,
        })
        await execChecked('bash', ['deploy/scripts/apply-rls.sh'], { cwd: cfg.repoDir, onLog: push })
        await execChecked('bash', ['deploy/scripts/verify-install.sh'], { cwd: cfg.repoDir, onLog: push })
        await writePostUpdateSignal(cfg.repoDir, await readPackageVersion(cfg.repoDir), 'update-runner', updateBranch)
        lastRun = { ...lastRun!, ok: true, finishedAt: new Date().toISOString() }
        push('Update complete')
      } catch (err) {
        lastRun = { ...lastRun!, ok: false, finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }
        push(`Update failed: ${lastRun.error}`)
      } finally {
        running = false
      }
    })()
    return { ok: true }
  }

  const logState = async (): Promise<UpdateLogState> => ({ running, logs, lastRun })

  const settings = async (): Promise<UpdateNotificationSettings> => settingsFromEnv(await readRuntimeEnv(cfg.repoDir), cfg.branch)

  const saveSettings = async (input: UpdateNotificationSettingsInput): Promise<UpdateNotificationSettings> => {
    const currentEnv = await readRuntimeEnv(cfg.repoDir)
    const current = settingsFromEnv(currentEnv, cfg.branch)
    const values = updateSettingsValues(input, currentEnv, current, cfg.branch)
    requireEnabledBitbucketSettings(values)
    try {
      await writeRuntimeEnv(cfg.repoDir, values)
    } catch {
      throw new UpdateRunnerError(
        'runtime_env_unavailable',
        'Application update settings could not be saved because the runtime environment file is not writable.',
        'Ensure the local installation has a writable .env.persistent-memory file, then try again.',
        500,
      )
    }
    return settingsFromEnv(await readRuntimeEnv(cfg.repoDir), cfg.branch)
  }

  const testSettings = async (input: UpdateNotificationSettingsInput): Promise<UpdateConnectionTestResult> => {
    const currentEnv = await readRuntimeEnv(cfg.repoDir)
    const current = settingsFromEnv(currentEnv, cfg.branch)
    const values = updateSettingsValues({ ...input, enabled: true, provider: 'bitbucket' }, currentEnv, current, cfg.branch)
    requireEnabledBitbucketSettings(values)
    let metadata: RemoteMetadata | null
    try {
      metadata = await readBitbucketMetadata(values, cfg.branch)
    } catch (err) {
      if (err instanceof UpdateRunnerError) throw err
      throw new UpdateRunnerError(
        'bitbucket_connection_failed',
        'Could not reach Bitbucket while checking the update source.',
        'Check the Bitbucket URL, VPN connection, and server availability.',
      )
    }
    const latestCommit = metadata?.latestCommit
    if (!metadata || !latestCommit) {
      throw new UpdateRunnerError(
        'bitbucket_connection_failed',
        'Bitbucket did not return a commit for the configured branch.',
        'Check the repository owner, repository name, and branch.',
      )
    }
    const scope = values.UPDATE_BITBUCKET_SCOPE
    const owner = scope === 'user' ? values.UPDATE_BITBUCKET_USER : values.UPDATE_BITBUCKET_PROJECT
    return {
      ok: true,
      provider: 'bitbucket',
      repository: `${owner}/${values.UPDATE_BITBUCKET_REPO}`,
      branch: values.UPDATE_BITBUCKET_BRANCH ?? cfg.branch,
      latestCommit,
      latestVersion: metadata.latestVersion,
    }
  }

  return { status, start, logs: logState, settings, saveSettings, testSettings }
}
