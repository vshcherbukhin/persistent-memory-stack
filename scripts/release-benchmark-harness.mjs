/**
 * Compose isolation helpers for release benchmarks.
 *
 * This intentionally derives a temporary Compose file rather than modifying the
 * operator's stack or reusing its named containers, network, volumes, images, or
 * environment file. The caller writes the returned files under `.local/` and
 * destroys the exact `pm-benchmark-*` project after collecting sanitized results.
 */

import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const BENCHMARK_PREFIX = 'pm-benchmark-'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const serviceNames = [
  'dashboard-legacy-upgrade',
  'dashboard-gateway',
  'docker-control',
  'update-runner',
  'documentation',
  'falkordb',
  'graphiti',
  'postgres',
  'qdrant',
  'dashboard',
  'worker',
  'minio',
  'redis',
  'neo4j',
  'dlp',
  'mcp',
  'api',
]

const benchmarkServices = new Set(['postgres', 'qdrant', 'falkordb', 'redis', 'minio', 'dlp', 'graphiti', 'api', 'worker'])

function retainBenchmarkServices(compose) {
  const lines = compose.split('\n')
  const output = []
  let inServices = false
  let skipping = false
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true
      output.push(line)
      continue
    }
    if (inServices && /^[^\s]/.test(line) && line.trim()) {
      inServices = false
      skipping = false
    }
    const service = inServices ? line.match(/^  ([a-z0-9-]+):\s*$/)?.[1] : undefined
    if (service) skipping = !benchmarkServices.has(service)
    if (!skipping) output.push(line)
  }
  return output.join('\n')
}

function assertBenchmarkRunId(runId) {
  if (!new RegExp(`^${BENCHMARK_PREFIX}[a-z0-9-]+$`).test(runId)) {
    throw new Error(`Benchmark Compose project must begin with ${BENCHMARK_PREFIX}.`)
  }
}

function removePortBlocks(compose) {
  const lines = compose.split('\n')
  const output = []
  let skipping = false
  for (const line of lines) {
    if (/^    ports:\s*$/.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^      - /.test(line)) continue
    if (skipping) skipping = false
    output.push(line)
  }
  return output.join('\n')
}

/** Build a no-port, no-container-name Compose source plus a small API-only port override. */
export function createBenchmarkHarness({ source, runId }) {
  assertBenchmarkRunId(runId)
  // Git can check out Compose with CRLF on Windows. Normalize before line-based
  // isolation transforms so no production container names or mounts survive.
  let compose = source.replace(/\r\n/g, '\n')
    .replace(/^name: persistent-memory\s*$/m, 'name: ${PM_BENCHMARK_COMPOSE_NAME:?PM_BENCHMARK_COMPOSE_NAME is required}')
    .replace(/^\s+container_name:.*\n/gm, '')
    .replace(/^\s+restart: unless-stopped\s*\n/gm, '')
    .replace(/- \.\.\/\.\.\/\.env\.persistent-memory/g, '- ${PM_BENCHMARK_ENV_FILE:?PM_BENCHMARK_ENV_FILE is required}')
    .replace(/^\s+image: persistent-memory-([\w-]+):latest\s*$/gm, '    image: ${PM_BENCHMARK_IMAGE_PREFIX}-$1:latest')
    // The production Compose source supports a caller-supplied namespace. A
    // benchmark strips container names, so it must use service DNS names and its
    // own images/env file rather than fall back to an operator's namespace.
    .replaceAll('${PM_IMAGE_PREFIX:-persistent-memory}-', '${PM_BENCHMARK_IMAGE_PREFIX}-')
    .replaceAll('${PM_CONTAINER_PREFIX:-persistent-memory}-', '')
    .replaceAll('${PM_RUNTIME_ENV_FILE:-../../.env.persistent-memory}', '${PM_BENCHMARK_ENV_FILE:?PM_BENCHMARK_ENV_FILE is required}')
    .replaceAll('${PM_VOLUME_PREFIX:-persistent_memory}', 'benchmark')
    .replaceAll('${PM_NETWORK_NAME:-persistent_memory_network}', 'benchmark_network')

  compose = removePortBlocks(compose)
  // The benchmark Compose artifact must be safe even when an operator reaches
  // for bare `docker compose up`: remove dashboard/update/socket services rather
  // than merely relying on the CLI service allow-list.
  compose = retainBenchmarkServices(compose)
  // Compose prefixes unnamed volumes/networks with our dynamic project name. Rename
  // their keys too, then remove fixed global `name:` values from the source file.
  compose = compose.replaceAll('persistent_memory_', 'benchmark_')
  compose = compose.replace(/^\s+name: benchmark_[\w_]+\s*\n/gm, '')
  for (const service of serviceNames) {
    compose = compose.replaceAll(`persistent-memory-${service}`, service)
  }
  // The generated Compose source lives under .local/, so its repository-relative
  // build contexts and source mounts must be rebound to the real checkout.
  compose = compose
    .replaceAll('context: ../..', 'context: ${PM_BENCHMARK_SOURCE_ROOT:?PM_BENCHMARK_SOURCE_ROOT is required}')
    .replaceAll('context: ../../apps/', 'context: ${PM_BENCHMARK_SOURCE_ROOT:?PM_BENCHMARK_SOURCE_ROOT is required}/apps/')
    .replaceAll('- ../..:', '- ${PM_BENCHMARK_SOURCE_ROOT:?PM_BENCHMARK_SOURCE_ROOT is required}:')

  const override = [
    'services:',
    '  api:',
    '    ports:',
    '      - "127.0.0.1:${PM_BENCHMARK_API_PORT}:8090"',
    '  postgres:',
    '    ports:',
    '      - "127.0.0.1:${PM_BENCHMARK_POSTGRES_PORT}:5432"',
    '',
  ].join('\n')

  return { composeProject: runId, compose, override }
}

function parseDotEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) return []
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2')
    return [[match[1], value]]
  }))
}

function secret() {
  return randomBytes(24).toString('base64url')
}

async function freeLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

function providerSettings(sourceEnv) {
  const provider = sourceEnv.EXTRACTION_PROVIDER || 'anthropic'
  const requiredKey = provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : null
  if (requiredKey && !sourceEnv[requiredKey]) {
    throw new Error(`Benchmark requires ${requiredKey} for EXTRACTION_PROVIDER=${provider}; no benchmark stack was started.`)
  }
  return Object.fromEntries([
    'EXTRACTION_PROVIDER', 'EXTRACTION_MODEL', 'EMBED_PROVIDER', 'EMBED_MODEL', 'EMBED_DIM', 'OLLAMA_URL',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY',
  ].flatMap((key) => sourceEnv[key] ? [[key, sourceEnv[key]]] : []))
}

export async function prepareBenchmarkHarness({ runId, envPath = resolve(root, '.env.persistent-memory') }) {
  assertBenchmarkRunId(runId)
  const runDir = resolve(root, '.local', 'release-benchmark', runId)
  const [composeSource, sourceEnvText] = await Promise.all([readFile(resolve(root, 'deploy/compose/docker-compose.yml'), 'utf8'), readFile(envPath, 'utf8')])
  const { compose, override, composeProject } = createBenchmarkHarness({ source: composeSource, runId })
  const [apiPort, postgresPort] = await Promise.all([freeLoopbackPort(), freeLoopbackPort()])
  const envFile = resolve(runDir, 'benchmark.env')
  const values = {
    PM_BENCHMARK_COMPOSE_NAME: composeProject,
    PM_BENCHMARK_ENV_FILE: envFile,
    PM_BENCHMARK_IMAGE_PREFIX: composeProject,
    PM_BENCHMARK_SOURCE_ROOT: root,
    PM_BENCHMARK_API_PORT: String(apiPort),
    PM_BENCHMARK_POSTGRES_PORT: String(postgresPort),
    PM_HOST_BIND: '127.0.0.1',
    // Server mode gives the disposable run its own bootstrap super-admin token,
    // so integration coverage can exercise team/mount/admin boundaries without
    // ever borrowing the user's local identity.
    DEPLOYMENT_MODE: 'server',
    PM_TEST_STACK: 'true',
    MEMORY_SURFACE: 'personal',
    POSTGRES_USER: 'pmuser',
    POSTGRES_PASSWORD: secret(),
    POSTGRES_DB: 'persistent_memory',
    PM_APP_PASSWORD: secret(),
    QDRANT_API_KEY: secret(),
    FALKORDB_PASSWORD: secret(),
    MINIO_ROOT_USER: 'pmadmin',
    MINIO_ROOT_PASSWORD: secret(),
    TOKEN_PEPPER: secret(),
    GRAPH_GROUP_SECRET: secret(),
    DOCKER_CONTROL_TOKEN: secret(),
    UPDATE_RUNNER_TOKEN: secret(),
    USAGE_INGEST_TOKEN: secret(),
    GRAPH_BACKEND: 'falkordb',
    GRAPHITI_TIMEOUT_MS: '120000',
    FALKORDB_QUERY_TIMEOUT_MS: '5000',
    ...providerSettings(parseDotEnv(sourceEnvText)),
  }
  await mkdir(runDir, { recursive: true })
  await Promise.all([
    writeFile(resolve(runDir, 'compose.yml'), compose, { mode: 0o600 }),
    writeFile(resolve(runDir, 'override.yml'), override, { mode: 0o600 }),
    writeFile(envFile, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 }),
    writeFile(resolve(runDir, 'manifest.json'), `${JSON.stringify({ runId, composeProject, apiPort, postgresPort, createdAt: new Date().toISOString(), services: ['postgres', 'qdrant', 'falkordb', 'redis', 'minio', 'dlp', 'graphiti', 'api', 'worker'] }, null, 2)}\n`, { mode: 0o600 }),
  ])
  await chmod(envFile, 0o600)
  return { runDir, envFile, apiPort, postgresPort, composeProject }
}

function composeCommand(harness, args) {
  return ['compose', '-p', harness.composeProject, '--env-file', harness.envFile, '-f', resolve(harness.runDir, 'compose.yml'), '-f', resolve(harness.runDir, 'override.yml'), ...args]
}

export function runBenchmarkCompose(harness, args) {
  const result = spawnSync('docker', composeCommand(harness, args), { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Benchmark Compose command failed: docker ${composeCommand(harness, args).join(' ')}`)
}

export function benchmarkMigrateUrl({ postgresPort, postgresUser, postgresPassword, postgresDb }) {
  return `postgresql://${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}@127.0.0.1:${postgresPort}/${encodeURIComponent(postgresDb)}`
}

function runBenchmarkCommand(command, args, options = {}) {
  const { quiet = false, ...spawnOptions } = options
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: quiet ? 'ignore' : spawnOptions.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    ...spawnOptions,
  })
  if (result.status !== 0) throw new Error(`Benchmark setup command failed: ${command} ${args.join(' ')}`)
}

function benchmarkEnv(harness) {
  return parseDotEnv(readFileSync(harness.envFile, 'utf8'))
}

/**
 * The seed runs on the host while the API runs in the isolated Compose project.
 * Keep the cryptographic settings identical or the freshly minted bootstrap
 * token cannot be verified by the API.
 */
export function benchmarkSeedEnv({ values, migrateUrl, tokenOutputPath }) {
  return {
    ...process.env,
    DATABASE_MIGRATE_URL: migrateUrl,
    TOKEN_PEPPER: values.TOKEN_PEPPER,
    BOOTSTRAP_TOKEN_OUTPUT_PATH: tokenOutputPath,
  }
}

/** Delete the sole secret-bearing runtime file while preserving a safe manifest. */
export async function removeBenchmarkRuntimeSecrets(runDir) {
  await Promise.all([
    rm(resolve(runDir, 'benchmark.env'), { force: true }),
    rm(resolve(runDir, 'bootstrap-token'), { force: true }),
  ])
}

function benchmarkImageNames(runId) {
  const listed = spawnSync('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], { cwd: root, encoding: 'utf8' })
  if (listed.status !== 0) throw new Error('Could not list benchmark images for cleanup verification.')
  return listed.stdout.split('\n').map((line) => line.trim()).filter((name) => name.startsWith(`${runId}-`))
}

function dockerResources(kind, runId) {
  const command = kind === 'containers' ? ['ps', '-aq'] : [kind, 'ls', '-q']
  const listed = spawnSync('docker', [...command, '--filter', `label=com.docker.compose.project=${runId}`], { cwd: root, encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`Could not verify disposable benchmark ${kind} cleanup.`)
  return listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Refuse to describe cleanup as complete while any run-scoped resource remains. */
export function assertBenchmarkCleanup({ containers, volumes, networks, images }) {
  for (const [kind, values] of Object.entries({ containers, volumes, networks, images })) {
    if (!Array.isArray(values) || values.length > 0) throw new Error(`Disposable benchmark cleanup left ${kind}.`)
  }
}

async function writeBenchmarkCleanup(harness) {
  const state = {
    containers: dockerResources('containers', harness.composeProject),
    volumes: dockerResources('volume', harness.composeProject),
    networks: dockerResources('network', harness.composeProject),
    images: benchmarkImageNames(harness.composeProject),
  }
  assertBenchmarkCleanup(state)
  await writeFile(resolve(harness.runDir, 'cleanup.json'), `${JSON.stringify({ runId: harness.composeProject, completedAt: new Date().toISOString(), ...state }, null, 2)}\n`, { mode: 0o600 })
}

function waitForBenchmarkPostgres(harness, values) {
  const args = composeCommand(harness, ['exec', '-T', 'postgres', 'pg_isready', '-U', values.POSTGRES_USER, '-d', values.POSTGRES_DB])
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = spawnSync('docker', args, { cwd: root, stdio: 'ignore' })
    if (result.status === 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  throw new Error('Disposable benchmark Postgres did not become ready within 30 seconds.')
}

/** Reproduce the production setup order against only the disposable database. */
export function bootstrapBenchmarkDatabase(harness) {
  const values = benchmarkEnv(harness)
  const migrateUrl = benchmarkMigrateUrl({
    postgresPort: harness.postgresPort,
    postgresUser: values.POSTGRES_USER,
    postgresPassword: values.POSTGRES_PASSWORD,
    postgresDb: values.POSTGRES_DB,
  })
  waitForBenchmarkPostgres(harness, values)
  runBenchmarkCommand('npm', ['run', '--silent', 'migrate:deploy'], {
    cwd: resolve(root, 'layers/core/schema'),
    env: { ...process.env, DATABASE_MIGRATE_URL: migrateUrl },
  })
  runBenchmarkCommand('docker', composeCommand(harness, [
    'exec', '-T', '-e', `PGOPTIONS=-c pm.app_password=${values.PM_APP_PASSWORD}`,
    'postgres', 'psql', '-U', values.POSTGRES_USER, '-d', values.POSTGRES_DB, '-v', 'ON_ERROR_STOP=1',
  ]), { input: readFileSync(resolve(root, 'layers/core/schema/rls.sql'), 'utf8') })
  runBenchmarkCommand('npm', ['run', '--silent', 'seed'], {
    cwd: resolve(root, 'layers/core/schema'),
    env: benchmarkSeedEnv({
      values,
      migrateUrl,
      // Used only by the isolated harness. The normal installer keeps the
      // one-time credential on stdout; this file stays mode 0600 under .local
      // and is deleted with benchmark.env during cleanup.
      tokenOutputPath: resolve(harness.runDir, 'bootstrap-token'),
    }),
    // The normal installer intentionally shows a one-time credential. A
    // disposable benchmark must never print its temporary credential.
    quiet: true,
  })
}

async function main() {
  const action = process.argv[2]
  if (action !== '--prepare' && action !== '--up' && action !== '--down') {
    throw new Error('Usage: node scripts/release-benchmark-harness.mjs --prepare|--up|--down [pm-benchmark-run-id]')
  }
  const supplied = process.argv[3]
  const runId = supplied || `${BENCHMARK_PREFIX}${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${process.pid}`
  if (action === '--down') {
    assertBenchmarkRunId(runId)
    const runDir = resolve(root, '.local', 'release-benchmark', runId)
    const manifest = JSON.parse(await readFile(resolve(runDir, 'manifest.json'), 'utf8'))
    if (manifest.runId !== runId || manifest.composeProject !== runId) throw new Error('Benchmark manifest identity mismatch; refusing cleanup.')
    runBenchmarkCompose({ runDir, envFile: resolve(runDir, 'benchmark.env'), composeProject: runId }, ['down', '--volumes', '--remove-orphans'])
    const images = benchmarkImageNames(runId)
    if (images.length > 0) runBenchmarkCommand('docker', ['image', 'rm', ...images])
    await removeBenchmarkRuntimeSecrets(runDir)
    await writeBenchmarkCleanup({ runDir, composeProject: runId })
    return
  }
  const harness = await prepareBenchmarkHarness({ runId })
  if (action === '--up') {
    // Bootstrap first, exactly as the installer does, so api/worker never boot
    // against an uninitialized pm_app role or missing local identity.
    runBenchmarkCompose(harness, ['up', '--build', '-d', 'postgres'])
    bootstrapBenchmarkDatabase(harness)
    runBenchmarkCompose(harness, ['up', '--build', '-d', 'qdrant', 'falkordb', 'redis', 'minio', 'dlp', 'graphiti', 'api', 'worker'])
  }
  process.stdout.write(`${JSON.stringify(harness)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
