import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { compareSemver, parseReleaseHistory, type ParsedRelease } from '../release-versioning/release.js'
import { publicUpdateSource, publicUpdateMetadataCache, type PublicUpdateMetadataCache } from './github.js'

export interface UpdateStatus {
  releaseLine: string
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  updateBranch?: string
  releaseTag?: string
  releaseUrl?: string
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
  /** Legacy config accepted for callers; public runner operations use releases. */
  branch?: string
}

type ExecResult = { code: number; stdout: string; stderr: string }


function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
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

export function createUpdateRunner(cfg: RunnerConfig, dependencies: { metadataCache?: PublicUpdateMetadataCache } = {}) {
  const running = false
  let logs: string[] = []
  let lastRun: UpdateRunSummary | undefined

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
      releaseTag: metadata?.releaseTag,
      releaseUrl: metadata?.releaseUrl,
      autoUpdateReady: false,
      currentCommit, latestCommit: metadata?.latestCommit,
      releaseNotes, mcpRestartRequired: releaseNotes?.mcpRestartRequired ?? false,
      running, lastRun, lastSuccessfulUpdate, logs,
    }
  }
  const start = async (): Promise<{ ok: boolean }> => {
    // Installation must use the host coordinator so required intermediate
    // releases, snapshots, checkpoints and recovery cannot be bypassed.
    const error = 'Run npm run update-persistent-memory from the repository terminal. The coordinator validates published releases and required upgrade steps.'
    const finishedAt = new Date().toISOString()
    logs = [error]
    lastRun = { ok: false, startedAt: finishedAt, finishedAt, error }
    return { ok: false }
  }
  const logState = async (): Promise<UpdateLogState> => ({ running, logs, lastRun })

  return { status, start, logs: logState }
}
