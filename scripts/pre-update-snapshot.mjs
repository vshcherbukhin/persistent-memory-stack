#!/usr/bin/env node
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { storageConfiguration, validateStorageContainer } from './prepare-falkordb-storage.mjs'

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

export function archiveLegacyFalkorRdb(backupPath, runner=run, config) {
  if(!config)throw new Error('Graph snapshot requires a validated installation namespace.')
  const inspected=runner('docker',['inspect','--type','container',config.containerName])
  if(inspected.status!==0){
    if(/no such (?:object|container)/i.test(inspected.stderr??''))return
    throw new Error('Graph container inspection failed; refusing an incomplete snapshot.')
  }
  let container
  try{container=JSON.parse(inspected.stdout)[0]}catch{throw new Error('Graph container identity is malformed.')}
  validateStorageContainer(container,config)
  if(!container.State?.Running)throw new Error('The original graph container is stopped. Start that exact container ID before snapshotting; do not recreate it with Compose.')
  const auth='export REDISCLI_AUTH="$FALKORDB_PASSWORD"; '
  const directory=runner('docker',['exec',container.Id,'sh','-c',`${auth}redis-cli --raw CONFIG GET dir dbfilename`])
  if(directory.status!==0)throw new Error('Cannot verify the active graph persistence settings.')
  const fields=directory.stdout.trim().split(/\r?\n/u),settings={}
  if(fields.length!==4)throw new Error('Graph persistence settings are ambiguous.')
  for(let i=0;i<fields.length;i+=2)settings[fields[i]]=fields[i+1]
  const actual=settings.dir,filename=settings.dbfilename
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(filename??''))throw new Error('The configured graph RDB filename is unsafe or unknown.')
  if(actual==='/data')return
  if(actual!=='/var/lib/falkordb/data')throw new Error('Unrecognized graph persistence directory; preserve the original container.')
  // SAVE is independently atomic. Full clean-stop RDB/AOF recovery is also
  // captured by the pre-recreate helper before any volume transfer.
  const saved=runner('docker',['exec',container.Id,'sh','-c',`${auth}redis-cli --raw SAVE`])
  if(saved.status!==0||saved.stdout.trim()!=='OK')throw new Error('Could not capture a consistent legacy graph RDB.')
  const copied=runner('docker',['cp',`${container.Id}:${actual}/${filename}`,join(backupPath,'falkordb-legacy-dump.rdb')])
  if(copied.status!==0)throw new Error('Could not preserve the actual legacy graph RDB.')
  writeJson(join(backupPath,'falkordb-storage.json'),{containerId:container.Id,sourceDirectory:actual,sourceFilename:filename,volumeDirectory:'/data',legacyRdb:'falkordb-legacy-dump.rdb',note:'For standalone RDB recovery start with appendonly disabled, then enable AOF after loading. The pre-recreate helper preserves complete RDB/AOF files.'})
  info('Preserved the actual legacy FalkorDB RDB outside its old mounted volume.')
}

export function installationPresent(config,runner=run){
  for(const service of ['postgres','falkordb','qdrant']){
    const result=runner('docker',['inspect','--type','container',`${config.prefix}-${service}`])
    if(result.status===0)return true
    if(!/no such (?:object|container)/i.test(result.stderr??''))throw new Error('Cannot establish installation presence safely.')
  }
  for(const suffix of ['postgres_data','qdrant_data','falkordb_data']){
    const result=runner('docker',['volume','inspect',`${config.volumePrefix}_${suffix}`])
    if(result.status===0)return true
    if(!/no such volume/i.test(result.stderr??''))throw new Error('Cannot establish installation volume presence safely.')
  }
  return false
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
  const env = parseEnvFile(envPath)
  const storage = storageConfiguration(readFileSync(envPath,'utf8'),envPath)
  const hasLiveInstall = installationPresent(storage)
  if (!hasLiveInstall) {
    info('No existing persistent-memory containers/volumes found; skipping.')
    return
  }

  mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupRoot, `${stamp}-${source}`)
  mkdirSync(backupPath, { recursive: true, mode: 0o700 })
  writeJson(join(backupPath, 'manifest.json'), {
    createdAt: new Date().toISOString(),
    repoDir: repoRoot,
    currentVersion: currentVersion(),
    currentCommit: commit,
    source,
    includes: [
      '.env.persistent-memory',
      'compose service inventory',
      'postgres pg_dump when available',
      'qdrant/falkordb/neo4j/postgres/redis/minio volume archives when volumes exist',
      'mcp config report',
    ],
  })
  copyFileSync(envPath, join(backupPath, '.env.persistent-memory'))
  chmodSync(join(backupPath, '.env.persistent-memory'), 0o600)

  const composeArgs = ['compose', '-f', join(repoRoot, 'deploy', 'compose', 'docker-compose.yml'), '--env-file', envPath]
  if ((env.PM_MCP_RUNTIME ?? 'node') === 'stream') composeArgs.push('--profile', 'mcp-stream')
  const composePs = run('docker', [...composeArgs, 'ps'])
  writeFileSync(join(backupPath, 'compose-ps.txt'), composePs.stdout || composePs.stderr || '', { mode: 0o600 })

  if (containerRunning(`${storage.prefix}-postgres`)) {
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

  archiveVolume(backupPath, { label: 'qdrant', container: `${storage.prefix}-qdrant`, destination: '/qdrant/storage', fallbackVolume: `${storage.volumePrefix}_qdrant_data` })
  archiveVolume(backupPath, { label: 'falkordb', container: `${storage.prefix}-falkordb`, destination: '/data', fallbackVolume: `${storage.volumePrefix}_falkordb_data` })
  archiveLegacyFalkorRdb(backupPath,run,storage)
  archiveVolume(backupPath, { label: 'neo4j', container: `${storage.prefix}-neo4j`, destination: '/data', fallbackVolume: `${storage.volumePrefix}_neo4j_data` })
  archiveVolume(backupPath, { label: 'postgres-volume', container: `${storage.prefix}-postgres`, destination: '/var/lib/postgresql/data', fallbackVolume: `${storage.volumePrefix}_postgres_data`, required: true })
  archiveVolume(backupPath, { label: 'redis', container: `${storage.prefix}-redis`, destination: '/data', fallbackVolume: `${storage.volumePrefix}_redis_data` })
  archiveVolume(backupPath, { label: 'minio', container: `${storage.prefix}-minio`, destination: '/data', fallbackVolume: `${storage.volumePrefix}_minio_data` })

  writeJson(join(backupPath, 'mcp-config-report.json'), {
    generatedAt: new Date().toISOString(),
    mcpRuntime: env.PM_MCP_RUNTIME || 'node',
    note: 'Restart Claude/Codex when release notes or changed paths report MCP changes.',
  })
  if (fromSetup) writeFileSync(markerPath, `${commit}\n`, { mode: 0o600 })
  info(`Snapshot written to ${backupPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
