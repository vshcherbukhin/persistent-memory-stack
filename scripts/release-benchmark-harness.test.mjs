import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBenchmarkCleanup, benchmarkMigrateUrl, benchmarkSeedEnv, createBenchmarkHarness, removeBenchmarkRuntimeSecrets } from './release-benchmark-harness.mjs'

test('creates a Compose-safe disposable benchmark topology without production names or env files', async () => {
  const source = await readFile(new URL('../deploy/compose/docker-compose.yml', import.meta.url), 'utf8')
  const harness = createBenchmarkHarness({ source, runId: 'pm-benchmark-test-20260717' })

  assert.match(harness.compose, /^name: \$\{PM_BENCHMARK_COMPOSE_NAME/m)
  assert.doesNotMatch(harness.compose, /^\s+container_name:/m)
  assert.doesNotMatch(harness.compose, /persistent_memory_(postgres|qdrant|falkordb)_data/)
  assert.doesNotMatch(harness.compose, /^\s*- \.\.\/\.\.\/\.env\.persistent-memory$/m)
  assert.doesNotMatch(harness.compose, /^\s+image: persistent-memory-/m)
  assert.match(harness.compose, /image: \$\{PM_BENCHMARK_IMAGE_PREFIX\}-(api|graphiti|worker):latest/)
  assert.doesNotMatch(harness.compose, /^\s+ports:/m)
  assert.doesNotMatch(harness.compose, /\/var\/run\/docker\.sock/)
  assert.doesNotMatch(harness.compose, /\.\.\/\.\.:\/workspace/)
  assert.doesNotMatch(harness.compose, /PM_(IMAGE_PREFIX|CONTAINER_PREFIX|RUNTIME_ENV_FILE|VOLUME_PREFIX|NETWORK_NAME)/)
  assert.doesNotMatch(harness.compose, /^  (docker-control|update-runner|dashboard-gateway|dashboard):/m)
  assert.match(harness.compose, /DATABASE_URL: postgresql:\/\/pm_app:\$\{PM_APP_PASSWORD:-pmapp\}@postgres:5432/)
  assert.match(harness.override, /127\.0\.0\.1:\$\{PM_BENCHMARK_API_PORT\}:8090/)
  assert.match(harness.override, /127\.0\.0\.1:\$\{PM_BENCHMARK_POSTGRES_PORT\}:5432/)
  assert.match(harness.compose, /context: \$\{PM_BENCHMARK_SOURCE_ROOT/)
  assert.equal(harness.composeProject, 'pm-benchmark-test-20260717')
})

test('refuses a non-benchmark Compose project id', () => {
  assert.throws(
    () => createBenchmarkHarness({ source: 'name: persistent-memory\nservices: {}\n', runId: 'persistent-memory' }),
    /pm-benchmark-/,
  )
})

test('constructs an isolated owner migration URL with escaped disposable credentials', () => {
  assert.equal(
    benchmarkMigrateUrl({ postgresPort: 5544, postgresUser: 'pm user', postgresPassword: 'pw/a?', postgresDb: 'persistent memory' }),
    'postgresql://pm%20user:pw%2Fa%3F@127.0.0.1:5544/persistent%20memory',
  )
})

test('gives host-side seeding the isolated token pepper used by the API', () => {
  const env = benchmarkSeedEnv({
    values: { TOKEN_PEPPER: 'isolated-token-pepper' },
    migrateUrl: 'postgresql://isolated',
    tokenOutputPath: '/tmp/bootstrap-token',
  })
  assert.equal(env.TOKEN_PEPPER, 'isolated-token-pepper')
  assert.equal(env.DATABASE_MIGRATE_URL, 'postgresql://isolated')
  assert.equal(env.BOOTSTRAP_TOKEN_OUTPUT_PATH, '/tmp/bootstrap-token')
})

test('refuses to certify cleanup when any run-scoped resource remains', () => {
  assert.doesNotThrow(() => assertBenchmarkCleanup({ containers: [], volumes: [], networks: [], images: [] }))
  assert.throws(() => assertBenchmarkCleanup({ containers: ['leftover'], volumes: [], networks: [], images: [] }), /containers/)
})

test('removes all generated credential files while retaining safe benchmark artifacts', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'pm-benchmark-harness-'))
  try {
    await writeFile(join(runDir, 'benchmark.env'), 'ANTHROPIC_API_KEY=secret\n', { mode: 0o600 })
    await writeFile(join(runDir, 'bootstrap-token'), 'token.secret\n', { mode: 0o600 })
    await writeFile(join(runDir, 'manifest.json'), '{"runId":"pm-benchmark-test"}\n')
    await removeBenchmarkRuntimeSecrets(runDir)
    await assert.rejects(readFile(join(runDir, 'benchmark.env')))
    await assert.rejects(readFile(join(runDir, 'bootstrap-token')))
    assert.match(await readFile(join(runDir, 'manifest.json'), 'utf8'), /pm-benchmark-test/)
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})
