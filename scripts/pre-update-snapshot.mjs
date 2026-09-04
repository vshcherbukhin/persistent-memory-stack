#!/usr/bin/env node
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(repoRoot, '.env.persistent-memory')
const backupRoot = join(repoRoot, '.local', 'update-backups')
const markerPath = join(backupRoot, '.last-setup-snapshot-head')
const args = new Set(process.argv.slice(2))
const fromSetup = args.has('--from-setup')
const required = args.has('--required')
const sourceArg = process.argv.find((arg) => arg.startsWith('--source='))
const source = (sourceArg?.slice('--source='.length) || (fromSetup ? 'setup-compat' : 'manual')).replace(/[^a-zA-Z0-9_.-]/g, '-')

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

function fail(message) {
  console.error(`[pre-update-snapshot] ${message}`)
  process.exit(1)
}

function info(message) {
  console.log(`[pre-update-snapshot] ${message}`)
}

function parseEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
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

function currentCommit() {
  const res = run('git', ['rev-parse', 'HEAD'])
  return res.status === 0 ? res.stdout.trim() : 'unknown'
}

function currentVersion() {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return 'unknown'
  }
}

function dockerOk() {
  return run('docker', ['version', '--format', '{{.Server.Version}}']).status === 0
}

function containerExists(name) {
  return run('docker', ['inspect', name]).status === 0
}

function containerRunning(name) {
  const res = run('docker', ['inspect', '-f', '{{.State.Running}}', name])
  return res.status === 0 && res.stdout.trim() === 'true'
}

function volumeExists(name) {
  return run('docker', ['volume', 'inspect', name]).status === 0
}

function mountedVolume(container, destination) {
  const template = `{{range .Mounts}}{{if eq .Destination "${destination}"}}{{.Name}}{{end}}{{end}}`
  const res = run('docker', ['inspect', '-f', template, container])
  return res.status === 0 ? res.stdout.trim() : ''
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function updateNotificationSettingsFromEnv(env) {
  const provider = env.UPDATE_CHECK_PROVIDER === 'bitbucket' || env.UPDATE_CHECK_PROVIDER === 'git' ? env.UPDATE_CHECK_PROVIDER : 'none'
  const scope = env.UPDATE_BITBUCKET_SCOPE === 'user' ? 'user' : 'project'
  return {
    enabled: provider !== 'none',
    provider,
    bitbucket: {
      url: env.UPDATE_BITBUCKET_URL || '',
      tokenConfigured: Boolean(env.UPDATE_BITBUCKET_TOKEN),
      scope,
      project: env.UPDATE_BITBUCKET_PROJECT || '',
      user: env.UPDATE_BITBUCKET_USER || '',
      repo: env.UPDATE_BITBUCKET_REPO || '',
      branch: env.UPDATE_BITBUCKET_BRANCH || '',
    },
    note: 'Bitbucket token is redacted here; the raw value is preserved in the .env.persistent-memory snapshot.',
  }
}

function runToFile(command, commandArgs, stdoutPath, stderrPath, options = {}) {
  const stdoutFd = openSync(stdoutPath, 'w', 0o600)
  const stderrFd = openSync(stderrPath, 'w', 0o600)
  try {
    return run(command, commandArgs, { ...options, stdio: ['ignore', stdoutFd, stderrFd], encoding: 'buffer' })
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
    try {
      chmodSync(stdoutPath, 0o600)
      chmodSync(stderrPath, 0o600)
    } catch {
      /* best effort */
    }
  }
}

function archiveVolume(backupPath, { label, container, destination, fallbackVolume, required: volumeRequired = false }) {
  const volume = containerExists(container) ? mountedVolume(container, destination) : ''
  const resolvedVolume = volume || (volumeExists(fallbackVolume) ? fallbackVolume : '')
  if (!resolvedVolume) {
    const msg = `No volume found for ${label}; skipping.`
    if (volumeRequired) fail(msg)
    info(msg)
    return
  }
  const res = run('docker', [
    'run',
    '--rm',
    '-v',
    `${resolvedVolume}:/snapshot:ro`,
    '-v',
    `${backupPath}:/backup`,
    'alpine:3.20',
    'tar',
    '-czf',
    `/backup/${label}.tgz`,
    '-C',
    '/snapshot',
    '.',
  ])
  if (res.status !== 0) {
    const message = `Failed to archive ${label}: ${res.stderr || res.stdout}`.trim()
    if (volumeRequired) fail(message)
    writeFileSync(join(backupPath, `${label}-error.txt`), `${message}\n`, { mode: 0o600 })
    info(message)
    return
  }
  info(`Archived ${label}.`)
}

function shouldSkipSetupSnapshot(commit) {
  if (!fromSetup) return false
  if (process.env.PM_SKIP_SETUP_SNAPSHOT === '1') return true
  if (!existsSync(markerPath)) return false
  return readFileSync(markerPath, 'utf8').trim() === commit
}

function main() {
  if (!existsSync(envPath)) {
    info('No .env.persistent-memory found; skipping.')
    return
  }
  const commit = currentCommit()
  if (shouldSkipSetupSnapshot(commit)) {
    info('Snapshot already created for this setup commit; skipping.')
    return
  }
  if (!dockerOk()) {
    if (required || fromSetup) fail('Docker is not reachable; refusing to update without a snapshot check.')
    info('Docker is not reachable; skipping.')
    return
  }
  const hasLiveInstall =
    containerExists('persistent-memory-postgres') ||
    volumeExists('persistent_memory_postgres_data') ||
    volumeExists('persistent_memory_qdrant_data') ||
    volumeExists('persistent_memory_falkordb_data')
  if (!hasLiveInstall) {
    info('No existing persistent-memory containers/volumes found; skipping.')
    return
  }

  mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupRoot, `${stamp}-${source}`)
  mkdirSync(backupPath, { recursive: true, mode: 0o700 })
  const env = parseEnvFile(envPath)
  writeJson(join(backupPath, 'manifest.json'), {
    createdAt: new Date().toISOString(),
    repoDir: repoRoot,
    currentVersion: currentVersion(),
    currentCommit: commit,
    source,
    includes: [
      '.env.persistent-memory',
      'compose service inventory',
      'redacted update notification settings',
      'postgres pg_dump when available',
      'qdrant/falkordb/neo4j/postgres/redis/minio volume archives when volumes exist',
      'mcp config report',
    ],
  })
  copyFileSync(envPath, join(backupPath, '.env.persistent-memory'))
  chmodSync(join(backupPath, '.env.persistent-memory'), 0o600)
  writeJson(join(backupPath, 'update-notification-settings.json'), updateNotificationSettingsFromEnv(env))

  const composeArgs = ['compose', '-f', join(repoRoot, 'deploy', 'compose', 'docker-compose.yml'), '--env-file', envPath]
  if ((env.PM_MCP_RUNTIME ?? 'node') === 'stream') composeArgs.push('--profile', 'mcp-stream')
  const composePs = run('docker', [...composeArgs, 'ps'])
  writeFileSync(join(backupPath, 'compose-ps.txt'), composePs.stdout || composePs.stderr || '', { mode: 0o600 })

  if (containerRunning('persistent-memory-postgres')) {
    const stdout = join(backupPath, 'postgres.sql')
    const stderr = join(backupPath, 'postgres-dump-error.txt')
    const dump = runToFile('docker', [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      env.POSTGRES_USER || 'pmuser',
      env.POSTGRES_DB || 'persistent_memory',
    ], stdout, stderr)
    if (dump.status === 0) {
      rmSync(stderr, { force: true })
      info('Postgres dump written.')
    } else {
      info(`Postgres dump failed; volume archive will still be captured (${stderr}).`)
    }
  } else {
    writeFileSync(join(backupPath, 'postgres-dump-skipped.txt'), 'persistent-memory-postgres was not running; volume archive captured when available.\n', { mode: 0o600 })
  }

  archiveVolume(backupPath, { label: 'qdrant', container: 'persistent-memory-qdrant', destination: '/qdrant/storage', fallbackVolume: 'persistent_memory_qdrant_data' })
  archiveVolume(backupPath, { label: 'falkordb', container: 'persistent-memory-falkordb', destination: '/data', fallbackVolume: 'persistent_memory_falkordb_data' })
  archiveVolume(backupPath, { label: 'neo4j', container: 'persistent-memory-neo4j', destination: '/data', fallbackVolume: 'persistent_memory_neo4j_data' })
  archiveVolume(backupPath, { label: 'postgres-volume', container: 'persistent-memory-postgres', destination: '/var/lib/postgresql/data', fallbackVolume: 'persistent_memory_postgres_data', required: true })
  archiveVolume(backupPath, { label: 'redis', container: 'persistent-memory-redis', destination: '/data', fallbackVolume: 'persistent_memory_redis_data' })
  archiveVolume(backupPath, { label: 'minio', container: 'persistent-memory-minio', destination: '/data', fallbackVolume: 'persistent_memory_minio_data' })

  writeJson(join(backupPath, 'mcp-config-report.json'), {
    generatedAt: new Date().toISOString(),
    mcpRuntime: env.PM_MCP_RUNTIME || 'node',
    note: 'Restart Claude/Codex when release notes or changed paths report MCP changes.',
  })
  if (fromSetup) writeFileSync(markerPath, `${commit}\n`, { mode: 0o600 })
  info(`Snapshot written to ${backupPath}`)
}

main()
