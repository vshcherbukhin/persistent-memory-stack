#!/usr/bin/env node
/**
 * Executes release evidence against one already-running disposable benchmark
 * stack. It never accepts a non `pm-benchmark-*` run id and writes only a
 * sanitized JSON artifact under `.local/benchmark-results/`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { aggregateUsageWindow, isCanonicalUuid, summarizeOperation } from './system-health-evidence.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const runPrefix = 'pm-benchmark-'
const now = () => new Date().toISOString()
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run') values.run = argv[index + 1]
    if (argv[index] === '--label') values.label = argv[index + 1]
    if (argv[index] === '--finalize-cleanup') values.finalizeCleanup = true
  }
  return values
}

function assertBenchmarkLabel(label) {
  if (label !== undefined && label !== 'baseline' && label !== 'after') {
    throw new Error('P0 benchmark label must be baseline or after.')
  }
}

function assertRunId(runId) {
  if (!runId?.startsWith(runPrefix)) throw new Error(`System Health benchmark run id must begin with ${runPrefix}.`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function composeArgs(harness, args) {
  return ['compose', '-p', harness.composeProject, '--env-file', harness.envFile, '-f', resolve(harness.runDir, 'compose.yml'), '-f', resolve(harness.runDir, 'override.yml'), ...args]
}

function psql(harness, sql) {
  const result = spawnSync('docker', composeArgs(harness, [
    'exec', '-T', 'postgres', 'psql', '-U', 'pmuser', '-d', 'persistent_memory', '-At', '-F', '\t', '-c', sql,
  ]), { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not query the isolated benchmark database.')
  return result.stdout.trim().split('\n').filter(Boolean).map((row) => row.split('\t'))
}

function usageSnapshot(harness) {
  return psql(harness, "SELECT service, model, sum(requests), sum(tokens_in), sum(tokens_out) FROM model_usage_rollup GROUP BY service, model ORDER BY service, model")
    .map(([service, model, requests, tokensIn, tokensOut]) => ({ service, model, requests: Number(requests), tokensIn: Number(tokensIn), tokensOut: Number(tokensOut) }))
}

function normalizedUsageDelta(operation, before, after) {
  const beforeByKey = new Map(before.map((row) => [`${row.service}\u0000${row.model}`, row]))
  const baseline = after.map((row) => beforeByKey.get(`${row.service}\u0000${row.model}`) ?? { ...row, requests: 0, tokensIn: 0, tokensOut: 0 })
  // Graphiti has exact operation telemetry and is intentionally omitted from the
  // rollup delta to prevent it being counted twice in the final report.
  return aggregateUsageWindow(operation, baseline, after).filter((row) => row.service !== 'graphiti')
}

function graphUsageWindow(harness, operation, operationId) {
  if (!isCanonicalUuid(operationId)) {
    throw new Error('Graph telemetry correlation identifier must be a UUID.')
  }
  return psql(harness, `SELECT COALESCE(model, 'unknown'), count(*), COALESCE(sum(tokens_in), 0), COALESCE(sum(tokens_out), 0) FROM graph_usage_event WHERE operation_id = '${operationId}' GROUP BY model ORDER BY model`)
    .map(([model, requests, tokensIn, tokensOut]) => ({ operation, service: 'graphiti', model, requests: Number(requests), tokensIn: Number(tokensIn), tokensOut: Number(tokensOut) }))
}

async function waitForGraphUsageWindow(harness, operation, operationId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const usage = graphUsageWindow(harness, operation, operationId)
    if (usage.some((row) => row.requests > 0)) return usage
    await sleep(250)
  }
  throw new Error(`Graph token telemetry did not arrive for ${operation}.`)
}

async function request(base, method, path, token, body) {
  const started = Date.now()
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: response.status, json, acknowledgementMs: Date.now() - started, graphOperationId: response.headers.get('x-pm-graph-operation-id') }
}

async function waitForApi(base) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {}
    await sleep(1_000)
  }
  throw new Error('Disposable benchmark API did not become healthy within 60 seconds.')
}

async function waitForGraphState(harness, memoryId, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const [row] = psql(harness, `SELECT m.graph_status, count(p.*) FROM memory m LEFT JOIN graph_episode_provenance p ON p.subject_kind = 'memory' AND p.subject_id = m.id WHERE m.id = '${memoryId}'::uuid GROUP BY m.graph_status`)
    last = row ? { graphStatus: row[0], provenance: Number(row[1]) } : { graphStatus: 'missing', provenance: 0 }
    if (predicate(last)) return last
    await sleep(1_000)
  }
  throw new Error(`Graph state did not converge for benchmark memory (${last?.graphStatus ?? 'unknown'}).`)
}

function commandResult(name, command, args, env) {
  const started = Date.now()
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' })
  return { name, command: `${command} ${args.join(' ')}`, status: result.status === 0 ? 'pass' : 'fail', passed: result.status === 0 ? 1 : 0, failed: result.status === 0 ? 0 : 1, skipped: 0, durationMs: Date.now() - started }
}

async function provisionMember(base, adminToken) {
  const suffix = randomUUID().slice(0, 8)
  const team = await request(base, 'POST', '/dashboard/teams', adminToken, { name: `System health ${suffix}` })
  if (team.status !== 201) throw new Error(`Could not create isolated benchmark team (${team.status}).`)
  const user = await request(base, 'POST', '/dashboard/users', adminToken, { teamId: team.json.id, displayName: `System health ${suffix}` })
  if (user.status !== 201) throw new Error(`Could not create isolated benchmark user (${user.status}).`)
  // The token route validates an object body even when no optional fields are
  // supplied; send `{}` exactly as the public provisioning contract specifies.
  const token = await request(base, 'POST', `/dashboard/users/${user.json.id}/token`, adminToken, {})
  if (token.status !== 201) throw new Error(`Could not issue isolated benchmark member token (${token.status}).`)
  return { teamId: team.json.id, userId: user.json.id, token: token.json.wireToken }
}

async function cleanupMember(base, adminToken, member) {
  await request(base, 'DELETE', `/dashboard/users/${member.userId}`, adminToken, { confirm: true })
  await request(base, 'DELETE', `/dashboard/teams/${member.teamId}`, adminToken, { confirm: true })
}

async function measuredMemoryOperation({ name, harness, base, token, method, path, body, converge, requiresGraphTelemetry = false }) {
  const beforeUsage = usageSnapshot(harness)
  const startedAt = now()
  const response = await request(base, method, path, token, body)
  const sample = { acknowledgementMs: response.acknowledgementMs }
  if (response.status < 200 || response.status >= 300) return { response, sample: { ...sample, error: `HTTP ${response.status}` }, usage: [] }
  const convergenceStarted = Date.now()
  await converge(response.json)
  sample.convergenceMs = Date.now() - convergenceStarted
  const afterUsage = usageSnapshot(harness)
  if (requiresGraphTelemetry && !response.graphOperationId) throw new Error(`Graph telemetry correlation is missing for ${name}.`)
  const graphUsage = response.graphOperationId
    ? await waitForGraphUsageWindow(harness, name, response.graphOperationId)
    : []
  return {
    response,
    sample,
    usage: [...normalizedUsageDelta(name, beforeUsage, afterUsage), ...graphUsage],
  }
}

function baseGates(expectations) {
  return expectations.gates.map((gate) => ({
    id: gate.id,
    proofType: gate.proofType,
    status: gate.required === false ? 'not-measured' : 'not-run',
    evidence: gate.required === false ? 'explicitly deferred for this release' : 'not run in this isolated execution',
    durationMs: 0,
    retries: 0,
  }))
}

function markGates(gates, ids, status, evidence) {
  for (const gate of gates) if (ids.includes(gate.id)) Object.assign(gate, { status, evidence })
}

function liveRecallMetrics() {
  const path = resolve(root, '.local', 'benchmark-results', 'recall-context-live-latest.json')
  if (!existsSync(path)) return null
  const metrics = readJson(path)
  if (![1, 2].includes(metrics?.schemaVersion) || metrics?.status !== 'pass' || !Number.isInteger(metrics?.queryCount) || metrics.queryCount <= 0 || !Number.isInteger(metrics?.leakageCount) || metrics.leakageCount < 0) return null
  return metrics
}

function liveAgentMetrics() {
  const path = resolve(root, '.local', 'benchmark-results', 'recall-context-agent-eval-latest.json')
  if (!existsSync(path)) return null
  const metrics = readJson(path)
  if (metrics?.schemaVersion !== 1 || !['pass', 'fail'].includes(metrics?.status) || !Number.isInteger(metrics?.sampleCount) || metrics.sampleCount <= 0 || !Number.isInteger(metrics?.passed)) return null
  return metrics
}

function usageTokens(evidence, operation, service) {
  return (evidence.usage ?? [])
    .filter((row) => row.operation === operation && (!service || row.service === service))
    .reduce((total, row) => total + row.tokensIn + row.tokensOut, 0)
}

function renderP0Snapshot(evidence) {
  const recall = evidence.recall
  const metrics = recall?.recallMetrics
  const operationNames = [
    'memory-update-exact-noop',
    'memory-update-session-only',
    'memory-update-same-project',
    'memory-update-identical-metadata',
    'memory-update-metadata-only',
    'memory-update',
  ]
  return [
    `# P0 Token and Memory Quality ${evidence.label === 'baseline' ? 'Baseline' : 'After Snapshot'}`,
    '',
    `- Candidate: ${evidence.identity.gitSha}`,
    `- Corpus: ${evidence.identity.corpusHash}`,
    `- Recall queries: ${recall?.queryCount ?? 0}`,
    `- Cross-project leaks: ${recall?.leakageCount ?? 'missing'}`,
    `- Expected-memory hit rate: ${recall?.quality?.expectedMemoryHitRate ?? 'missing'}`,
    `- Mean reciprocal rank: ${recall?.quality?.meanReciprocalRank ?? 'missing'}`,
    `- Total recall bytes: ${metrics?.resultBytes?.total ?? 'missing'}`,
    `- Recall bytes p50 / p95 / max: ${metrics?.resultBytes?.p50 ?? 'missing'} / ${metrics?.resultBytes?.p95 ?? 'missing'} / ${metrics?.resultBytes?.max ?? 'missing'}`,
    `- Estimated recall tokens total: ${metrics?.estimatedTokens?.total ?? 'missing'}`,
    `- Estimated recall tokens p50 / p95 / max: ${metrics?.estimatedTokens?.p50 ?? 'missing'} / ${metrics?.estimatedTokens?.p95 ?? 'missing'} / ${metrics?.estimatedTokens?.max ?? 'missing'}`,
    `- Duplicate fact bytes: ${metrics?.facts?.duplicateFactBytes ?? 'missing'}`,
    `- Dangling fact references: ${metrics?.danglingFactRefs ?? 'missing'}`,
    `- Agent answers: ${evidence.agent?.passed ?? 0}/${evidence.agent?.sampleCount ?? 0} (${evidence.agent?.status ?? 'missing'})`,
    `- Agent input / output tokens: ${evidence.agent?.inputTokens ?? 'missing'} / ${evidence.agent?.outputTokens ?? 'missing'}`,
    '',
    '| Update scenario | Total model tokens | Fact extraction | Embeddings | Graphiti |',
    '|---|---:|---:|---:|---:|',
    ...operationNames.map((operation) => `| ${operation} | ${usageTokens(evidence, operation)} | ${usageTokens(evidence, operation, 'fact-extraction')} | ${usageTokens(evidence, operation, 'embeddings')} | ${usageTokens(evidence, operation, 'graphiti')} |`),
    '',
  ].join('\n')
}

function finalizeBenchmarkCleanup(run) {
  assertRunId(run)
  const runDir = resolve(root, '.local', 'release-benchmark', run)
  const cleanup = readJson(resolve(runDir, 'cleanup.json'))
  if (cleanup.runId !== run || !Array.isArray(cleanup.containers) || !Array.isArray(cleanup.volumes) || !Array.isArray(cleanup.networks) || !Array.isArray(cleanup.images) || cleanup.containers.length || cleanup.volumes.length || cleanup.networks.length || cleanup.images.length) {
    throw new Error('Benchmark cleanup proof is incomplete; refusing to certify cleanup.')
  }
  if (existsSync(resolve(runDir, 'benchmark.env')) || existsSync(resolve(runDir, 'bootstrap-token'))) {
    throw new Error('Benchmark runtime secrets remain; refusing to certify cleanup.')
  }
  const expectations = readJson(resolve(root, 'scripts/release-benchmark/specs/1.0.0.json'))
  const output = resolve(root, '.local', 'benchmark-results', `${expectations.release}-system-health.json`)
  const evidence = readJson(output)
  markGates(evidence.gates, ['benchmark.cleanup'], 'pass', 'isolated cleanup.json proves no benchmark containers, volumes, networks, images, or runtime credentials remain')
  evidence.cleanup = { status: 'pass', credentialsRemoved: true, volumesRemoved: true, derivedRowsRemaining: 0 }
  evidence.limitations = [...new Set([...(evidence.limitations ?? []), 'The disposable Compose project was removed after evidence collection; the report does not represent a production-load test.'])]
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`${output}\n`)
}

async function main() {
  const { run, label, finalizeCleanup } = parseArgs(process.argv.slice(2))
  assertRunId(run)
  assertBenchmarkLabel(label)
  if (finalizeCleanup) return finalizeBenchmarkCleanup(run)
  const runDir = resolve(root, '.local', 'release-benchmark', run)
  const manifest = readJson(resolve(runDir, 'manifest.json'))
  if (manifest.runId !== run || manifest.composeProject !== run) throw new Error('Benchmark manifest identity mismatch; refusing execution.')
  const harness = { runDir, composeProject: run, envFile: resolve(runDir, 'benchmark.env') }
  const expectations = readJson(resolve(root, 'scripts/release-benchmark/specs/1.0.0.json'))
  const adminToken = readFileSync(resolve(runDir, 'bootstrap-token'), 'utf8').trim()
  if (!adminToken) throw new Error('Disposable benchmark bootstrap token is unavailable.')
  const base = `http://127.0.0.1:${manifest.apiPort}`
  await waitForApi(base)

  const startedAt = now()
  const gates = baseGates(expectations)
  const operations = []
  const usage = []
  const suites = []
  const project = `system_health_${Date.now()}`
  const member = await provisionMember(base, adminToken)
  let benchmarkMemoryId = null
  let secondaryMemoryId = null
  let recallMetrics = null
  let agentMetrics = null
  let recallSuite = { name: 'MCP 24-query recall matrix', command: 'not run', status: 'fail', passed: 0, failed: 1, skipped: 0, durationMs: 0 }
  let agentSuite = { name: 'Pinned agent recall sample', command: 'not run', status: 'fail', passed: 0, failed: 1, skipped: 0, durationMs: 0 }
  let integrationSuite = { name: 'isolated integration suite', command: 'not run', status: 'fail', passed: 0, failed: 1, skipped: 0, durationMs: 0 }
  try {
    const firstContent = '[component_system_health_widget] The system health widget failed while the benchmark added its first memory. Root cause: benchmark setup. Fix: preserve project scope. Prevention: record graph provenance.'
    const add = await measuredMemoryOperation({
      name: 'memory-add', harness, base, token: member.token, method: 'POST', path: '/memories',
      body: { content: firstContent, project, metadata: { category: 'fix', entities: ['component_system_health_widget'], source: 'user-correction' } },
      converge: async (created) => { benchmarkMemoryId = created.id; await waitForGraphState(harness, created.id, (state) => state.graphStatus === 'ok' && state.provenance > 0) }, requiresGraphTelemetry: true,
    })
    operations.push(summarizeOperation('memory-add', [add.sample])); usage.push(...add.usage)
    if (!benchmarkMemoryId) throw new Error('Benchmark add did not return a memory id.')

    const optionalGraphConvergence = async () => waitForGraphState(harness, benchmarkMemoryId, (state) => state.graphStatus === 'ok' && state.provenance > 0)
    for (const scenario of [
      { name: 'memory-update-exact-noop', body: { content: firstContent }, converge: optionalGraphConvergence },
      { name: 'memory-update-session-only', body: { sessionId: 'p0_benchmark_session' }, converge: async () => {} },
      { name: 'memory-update-same-project', body: { project }, converge: optionalGraphConvergence },
      { name: 'memory-update-identical-metadata', body: { metadata: { category: 'fix', entities: ['component_system_health_widget'], source: 'user-correction' } }, converge: optionalGraphConvergence },
      { name: 'memory-update-metadata-only', body: { metadata: { category: 'gotcha', entities: ['component_system_health_widget'], source: 'user-correction' } }, converge: optionalGraphConvergence },
    ]) {
      const measured = await measuredMemoryOperation({
        name: scenario.name, harness, base, token: member.token, method: 'PATCH', path: `/memories/${benchmarkMemoryId}`,
        body: scenario.body, converge: scenario.converge,
      })
      operations.push(summarizeOperation(scenario.name, [measured.sample])); usage.push(...measured.usage)
    }

    const updatedContent = '[component_system_health_widget] The system health widget was updated after the first benchmark memory. Root cause: prior benchmark wording. Fix: preserve the same project scope. Prevention: retain graph provenance.'
    const update = await measuredMemoryOperation({
      name: 'memory-update', harness, base, token: member.token, method: 'PATCH', path: `/memories/${benchmarkMemoryId}`,
      body: { content: updatedContent },
      converge: async () => waitForGraphState(harness, benchmarkMemoryId, (state) => state.graphStatus === 'ok' && state.provenance > 0), requiresGraphTelemetry: true,
    })
    operations.push(summarizeOperation('memory-update', [update.sample])); usage.push(...update.usage)

    const secondaryContent = '[component_system_health_secondary] The system health secondary memory exists only to prove non-primary deletion. Root cause: benchmark lifecycle. Fix: remove only this derived episode. Prevention: wait for lifecycle completion.'
    const secondary = await measuredMemoryOperation({
      name: 'memory-add-secondary', harness, base, token: member.token, method: 'POST', path: '/memories',
      body: { content: secondaryContent, project, metadata: { category: 'fix', entities: ['component_system_health_secondary'], source: 'user-correction' } },
      converge: async (created) => { secondaryMemoryId = created.id; await waitForGraphState(harness, created.id, (state) => state.graphStatus === 'ok' && state.provenance > 0) }, requiresGraphTelemetry: true,
    })
    operations.push(summarizeOperation('memory-add-secondary', [secondary.sample])); usage.push(...secondary.usage)
    if (!secondaryMemoryId) throw new Error('Benchmark secondary add did not return a memory id.')

    const remove = await measuredMemoryOperation({
      name: 'memory-delete-non-primary', harness, base, token: member.token, method: 'DELETE', path: `/memories/${secondaryMemoryId}`,
      converge: async () => waitForGraphState(harness, secondaryMemoryId, (state) => state.graphStatus === 'missing'),
    })
    operations.push(summarizeOperation('memory-delete-non-primary', [remove.sample])); usage.push(...remove.usage)

    recallSuite = commandResult('MCP 24-query recall matrix', 'npm', ['test', '-w', 'persistent-memory-mcp', '--', 'test/recall-context-live.test.ts'], {
      API_URL: base,
      PM_USER_TOKEN: member.token,
      PM_LIVE_MEMORY_EVAL: '1',
      PM_LIVE_MEMORY_EVAL_KEEP: '0',
    })
    suites.push(recallSuite)
    recallMetrics = liveRecallMetrics()
    agentSuite = commandResult('Pinned agent recall sample', 'node', ['scripts/run-recall-agent-sample.mjs', '--env', harness.envFile], {})
    suites.push(agentSuite)
    agentMetrics = liveAgentMetrics()
    integrationSuite = commandResult('isolated integration suite', 'npm', ['run', 'test:integration'], {
      PM_API_BASE: base,
      PM_BOOTSTRAP_TOKEN: adminToken,
      PM_ALLOW_LIVE_INTEGRATION: '1',
      PM_TEST_STACK: '1',
    })
    suites.push(integrationSuite)

    const measuredPass = operations.every((operation) => operation.failureCount === 0)
    markGates(gates, ['memory.add-update-provenance'], measuredPass ? 'pass' : 'fail', 'isolated add/update acknowledgement plus graph convergence')
    markGates(gates, ['memory.delete-lifecycle'], measuredPass ? 'pass' : 'fail', 'isolated non-primary delete plus absence convergence')
    const recallStatus = recallSuite.status === 'pass' && recallMetrics?.leakageCount === 0 && agentSuite.status === 'pass' && agentMetrics?.status === 'pass' ? 'pass' : 'fail'
    markGates(gates, ['recall.graph-picture', 'retrieval.relevance', 'retrieval.multi-hop-context', 'retrieval.duplicate-occupancy', 'retrieval.distractor-noise', 'recall.cross-project-isolation', 'graph.temporal-history'], recallStatus, 'isolated MCP recall matrix with all response planes checked against the named project')
    markGates(gates, ['access.team-surface-boundaries', 'security.write-gates', 'documents.file-lifecycle', 'workers.catalog-and-retry'], integrationSuite.status, 'isolated HTTP integration suite')
  } finally {
    if (benchmarkMemoryId) await request(base, 'DELETE', `/memories/${benchmarkMemoryId}`, member.token).catch(() => {})
    await cleanupMember(base, adminToken, member).catch(() => {})
  }

  const evidence = {
    schemaVersion: 1,
    release: expectations.release,
    identity: { candidate: 'dev candidate', corpusHash: 'system-health-isolated-v1', startedAt, completedAt: now() },
    gates,
    operations,
    queries: [{ name: 'MCP recall matrix', samples: recallMetrics?.queryCount ?? 0, expectedEvidence: 'project-scoped semantic memories, graph facts, entities, timeline, and contradictions', observed: recallSuite.status === 'pass' && recallMetrics?.leakageCount === 0 ? 'pass' : 'fail', leakageCount: recallMetrics?.leakageCount ?? 1 }],
    usage,
    suites,
    cleanup: { status: 'not-run', credentialsRemoved: false, volumesRemoved: false, derivedRowsRemaining: 0 },
    limitations: ['The isolated data-plane run does not itself perform browser or full candidate-suite checks; the release report records those as separate declared evidence types.', 'Graphiti token windows use the response-correlated operation ID and are not added again to the overlapping model rollup.'],
  }
  const outputDir = resolve(root, '.local', 'benchmark-results')
  mkdirSync(outputDir, { recursive: true })
  const output = resolve(outputDir, `${expectations.release}-system-health.json`)
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  if (label) {
    const p0Evidence = {
      schemaVersion: 1,
      label,
      identity: {
        candidate: manifest.runId,
        gitSha: process.env.PM_BENCHMARK_GIT_SHA ?? 'working-tree',
        corpusHash: 'p0-token-quality-v1',
        startedAt,
        completedAt: now(),
      },
      recall: recallMetrics,
      agent: agentMetrics ? {
        provider: agentMetrics.provider,
        model: agentMetrics.model,
        status: agentMetrics.status,
        sampleCount: agentMetrics.sampleCount,
        passed: agentMetrics.passed,
        inputTokens: agentMetrics.inputTokens,
        outputTokens: agentMetrics.outputTokens,
        results: agentMetrics.results.map((result) => ({
          id: result.id,
          pass: result.pass,
          inputBytes: result.inputBytes,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          missing: result.missing,
          forbidden: result.forbidden,
        })),
      } : null,
      operations,
      usage,
    }
    writeFileSync(resolve(outputDir, `p0-token-quality-${label}.json`), `${JSON.stringify(p0Evidence, null, 2)}\n`, 'utf8')
    writeFileSync(resolve(outputDir, `p0-token-quality-${label}.md`), `${renderP0Snapshot(p0Evidence)}\n`, 'utf8')
    if (recallSuite.status !== 'pass' || recallMetrics?.status !== 'pass' || agentSuite.status !== 'pass' || agentMetrics?.status !== 'pass' || integrationSuite.status !== 'pass') {
      process.exitCode = 1
    }
  }
  rmSync(resolve(outputDir, `${expectations.release}-system-health.failed.json`), { force: true })
  process.stdout.write(`${output}\n`)
}

function writeFailureArtifact(run) {
  if (!run?.startsWith(runPrefix)) return
  const expectations = readJson(resolve(root, 'scripts/release-benchmark/specs/1.0.0.json'))
  const outputDir = resolve(root, '.local', 'benchmark-results')
  mkdirSync(outputDir, { recursive: true })
  // A failed rerun supersedes prior success evidence for this release. Keeping
  // an old green file beside a current failure risks rendering stale results.
  rmSync(resolve(outputDir, `${expectations.release}-system-health.json`), { force: true })
  const evidence = {
    schemaVersion: 1,
    release: expectations.release,
    identity: { candidate: 'dev candidate', corpusHash: 'system-health-isolated-v1', startedAt: now(), completedAt: now() },
    gates: baseGates(expectations),
    operations: [],
    queries: [],
    usage: [],
    suites: [{ name: 'isolated system-health evidence runner', command: 'node scripts/run-system-health-benchmark.mjs', status: 'fail', passed: 0, failed: 1, skipped: 0, durationMs: 0 }],
    cleanup: { status: 'not-run', credentialsRemoved: false, volumesRemoved: false, derivedRowsRemaining: 0 },
    limitations: ['The isolated execution failed before complete evidence was recorded. See the disposable benchmark terminal log; the saved artifact intentionally excludes error text and secrets.'],
  }
  writeFileSync(resolve(outputDir, `${expectations.release}-system-health.failed.json`), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
}

main().catch((error) => {
  writeFailureArtifact(parseArgs(process.argv.slice(2)).run)
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
