import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { compareSemver, parseReleaseHistory, type ParsedRelease } from '../release-versioning/release.js'
import { publicUpdateSource, publicUpdateMetadataCache, isPublicUpdateRepository, type PublicUpdateMetadataCache } from './github.js'

export interface UpdateStatus {
  releaseLine: string
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
  releaseLine: string
  id: string
  source: 'update-script' | 'update-runner'
  version: string
  finishedAt: string
  branch?: string
  commit?: string
}

export interface RunnerConfig {
  repoDir: string
  backupRoot: string
  branch: string
}

type ExecResult = { code: number; stdout: string; stderr: string }
type RuntimeEnv = Record<string, string>
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
      windowsHide: true,
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

async function requirePublicUpdateOrigin(repoDir: string): Promise<void> {
  const remote = await readGitRef(repoDir, ['remote', 'get-url', 'origin'])
  if (!remote || !isPublicUpdateRepository(remote)) {
    throw new Error('The checkout origin does not match the public Persistent Memory repository. Check the trusted checkout origin before running an update.')
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
    const res = await fetch(deployedHistoryUrl, { signal: AbortSignal.timeout(2_000) })
    if (!res.ok) throw new Error(`deployed release history returned ${res.status}`)
    const history = await res.text()
    if (!history.includes(`<!-- persistent-memory-release-line: ${publicUpdateSource.releaseLine} -->`)) return packageVersion
    return parseReleaseHistory(history)[0]?.version ?? packageVersion
  } catch {
    return packageVersion
  }
}

const POST_UPDATE_SIGNAL_PATH = ['.local', 'update-state', 'last-successful-update.json'] as const

function isPostUpdateSignal(value: unknown): value is PostUpdateSignal {
  const input = value as Partial<PostUpdateSignal> | null
  return Boolean(
    input
      && input.releaseLine === publicUpdateSource.releaseLine
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
    releaseLine: publicUpdateSource.releaseLine,
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

async function readRuntimeEnv(repoDir: string): Promise<RuntimeEnv> {
  const envPath = join(repoDir, '.env.persistent-memory')
  if (!existsSync(envPath)) return {}
  return parseEnv(await readFile(envPath, 'utf8'))
}

async function fetchOrigin(repoDir: string, branch: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCommand('git', gitArgs(repoDir, ['fetch', '--quiet', 'origin', branch]), { cwd: repoDir, env })
  // Git tracing, credential helpers, proxies, and remote errors can echo secrets.
  // Never stream or surface fetch output when credentials may be in use.
  if (result.code !== 0) throw new Error('Git fetch failed for the configured update source.')
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
      'postgres pg_dump when available',
      'read-only mounted volume archives for qdrant, falkordb, redis, minio, postgres, neo4j when mounted',
      'compose service inventory',
    ],
  }
  await writeFile(join(backupPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  if (existsSync(join(cfg.repoDir, '.env.persistent-memory'))) {
    await execChecked('cp', ['.env.persistent-memory', join(backupPath, '.env.persistent-memory')], { cwd: cfg.repoDir, onLog })
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

export function createUpdateRunner(cfg: RunnerConfig, dependencies: { metadataCache?: PublicUpdateMetadataCache } = {}) {
  let running = false
  let logs: string[] = []
  let lastRun: UpdateRunSummary | undefined

  const push = (line: string): void => {
    for (const part of line.split(/\r?\n/u)) {
      if (!part) continue
      logs = [...logs.slice(-499), part]
    }
  }

  const metadataCache = dependencies.metadataCache ?? publicUpdateMetadataCache
  const status = async (): Promise<UpdateStatus> => {
    const [currentVersion, metadata, currentCommit, lastSuccessfulUpdate] = await Promise.all([
      readCurrentVersion(cfg.repoDir), metadataCache.read(),
      readGitRef(cfg.repoDir, ['rev-parse', 'HEAD']), readPostUpdateSignal(cfg.repoDir),
    ])
    const latestVersion = metadata?.latestVersion ?? null
    const releaseNotes = metadata ? parseReleaseHistory(metadata.releaseHistory)[0] ?? null : null
    return {
      releaseLine: publicUpdateSource.releaseLine,
      currentVersion, latestVersion,
      updateAvailable: Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0),
      updateBranch: publicUpdateSource.branch,
      autoUpdateReady: false,
      currentCommit, latestCommit: metadata?.latestCommit,
      releaseNotes, mcpRestartRequired: releaseNotes?.mcpRestartRequired ?? false,
      running, lastRun, lastSuccessfulUpdate, logs,
    }
  }
  const start = async (): Promise<{ ok: boolean }> => {
    if (running) return { ok: false }
    running = true
    logs = []
    lastRun = { ok: false, startedAt: new Date().toISOString() }
    void (async () => {
      try {
        const runtimeEnv = await readRuntimeEnv(cfg.repoDir)
        await requirePublicUpdateOrigin(cfg.repoDir)
        push('Starting snapshot-safe update')
        const backupPath = await createSnapshot(cfg, push)
        const databaseMigrateUrl = runtimeEnv.DATABASE_MIGRATE_URL ?? process.env.DATABASE_MIGRATE_URL ?? ''
        if (!databaseMigrateUrl) {
          throw new Error('DATABASE_MIGRATE_URL is missing in .env.persistent-memory; cannot run migrations safely')
        }
        lastRun = { ...lastRun!, backupPath }
        const updateBranch = cfg.branch || publicUpdateSource.branch
        try {
          await fetchOrigin(cfg.repoDir, updateBranch, { GIT_TERMINAL_PROMPT: '0' })
        } catch (err) {
          push(`git fetch failed; using cached origin/${updateBranch} if available.`)
          await execChecked('git', gitArgs(cfg.repoDir, ['rev-parse', `origin/${updateBranch}`]), { cwd: cfg.repoDir, onLog: push })
        }
        let targetPackage: { persistentMemoryReleaseLine?: unknown }
        try {
          targetPackage = JSON.parse(await execChecked('git', gitArgs(cfg.repoDir, ['show', `origin/${updateBranch}:package.json`]), { cwd: cfg.repoDir })) as typeof targetPackage
        } catch {
          throw new Error('Cannot verify the target public release line. The checkout has not been changed.')
        }
        if (targetPackage?.persistentMemoryReleaseLine !== publicUpdateSource.releaseLine) {
          throw new Error('The selected branch does not contain the public release line yet. The checkout has not been changed.')
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

  return { status, start, logs: logState }
}
