#!/usr/bin/env node
/**
 * Read-only report generator for a disposable release-benchmark harness run.
 *
 * The harness intentionally keeps credentials in its private runtime folder.
 * This script reads only aggregate operational counters through the isolated
 * Postgres container and emits a shareable Markdown report without connection
 * strings, tokens, memory text, or identifiers.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const RUN_PREFIX = 'pm-benchmark-'

function usage() {
  return 'Usage: node scripts/release-benchmark-report.mjs --run <pm-benchmark-…> [--output <report.md>]'
}

function args(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i]?.startsWith('--')) continue
    const key = argv[i].slice(2)
    values[key] = argv[i + 1]
    i += 1
  }
  return values
}

function parseRows(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
}

function readNumber(rows, key) {
  return Number(rows.find(([name]) => name === key)?.[1] ?? 0)
}

export function renderReport(input) {
  const generatedAt = new Date().toISOString()
  const graphTokens = input.graphUsage.input + input.graphUsage.output
  const modelTokens = input.models.reduce((sum, row) => sum + row.input + row.output, 0)
  const graphShare = modelTokens === 0 ? 'n/a' : `${((graphTokens / modelTokens) * 100).toFixed(1)}%`
  const allGraphRowsStamped =
    input.memoryCount > 0 &&
    input.memoryStatuses.length === 1 &&
    input.memoryStatuses[0]?.status === 'ok' &&
    input.memoryStatuses[0]?.count === input.memoryCount
  const hasGraphTelemetry = input.graphUsage.events > 0 && graphTokens > 0
  const passed = allGraphRowsStamped && input.lifecyclePending === 0 && input.memoryCount === input.provenanceCount && hasGraphTelemetry

  return [
    '---',
    'nav_title: Release quality run',
    'nav_group: benchmark-reports',
    'nav_group_title: Benchmark reports',
    'nav_group_order: 60',
    'nav_order: 10',
    '---',
    '# Release Quality Benchmark Report',
    '',
    `<div class="benchmark-report" data-status="${passed ? 'pass' : 'attention'}">`,
    '',
    `## ${passed ? 'Pass' : 'Attention required'}`,
    '',
    `Executed: **${generatedAt}**  `,
    `Disposable harness: \`${input.runId}\``,
    '',
    '<div class="benchmark-kpis">',
    `<div><strong>${input.memoryCount}</strong><span>memories written</span></div>`,
    `<div><strong>${input.provenanceCount}</strong><span>provenance rows</span></div>`,
    `<div><strong>${input.graphUsage.events}</strong><span>Graphiti usage events</span></div>`,
    `<div><strong>${graphShare}</strong><span>Graphiti token share</span></div>`,
    '</div>',
    '',
    '## Lifecycle and graph integrity',
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Memory rows | ${input.memoryCount} |`,
    `| Graph provenance rows | ${input.provenanceCount} |`,
    `| Pending/failed lifecycle removals | ${input.lifecyclePending} |`,
    ...input.memoryStatuses.map((row) => `| Memory graph status: ${row.status} | ${row.count} |`),
    '',
    'A passing run requires every persisted benchmark memory to have one provenance row, no pending graph status, and no unfinished lifecycle removal. The run exercises add + recall over the graph/timeline/contradiction path; deterministic API and worker tests cover update, deletion, stale-version cleanup, and scope rejection.',
    '',
    '## Token usage',
    '',
    '| Service/model | Requests | Input tokens | Output tokens | Total |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...input.models.map((row) => `| ${row.service} / ${row.model} | ${row.requests} | ${row.input} | ${row.output} | ${row.input + row.output} |`),
    `| **Graphiti telemetry** | ${input.graphUsage.events} | ${input.graphUsage.input} | ${input.graphUsage.output} | **${graphTokens}** |`,
    '',
    'Token values are isolated-run aggregates. They are not an invoice and exclude local CPU work. The Graphiti line is emitted from the Graphiti service with write-stage provenance; embedding rollups include both ingestion and the benchmark recall queries, so this report does not pretend to split them without per-operation instrumentation.',
    '',
    '## Coverage and boundaries',
    '',
    '- Project-scoped graph reads, including a similar-name cross-project distractor.',
    '- Graph facts, entity expansion, timeline entries, and contradiction/supersession signals.',
    '- Inline graph stamp under recall reinforcement; this run specifically proves reads no longer advance the graph content version.',
    '- Graphiti usage telemetry schema compatibility (camel-case header to snake-case API contract).',
    '- Provenance-aware stale-episode cleanup is covered by deterministic tests; the disposable harness is torn down after validation.',
    '',
    '## Interpretation',
    '',
    'This is a controlled synthetic regression corpus, not a claim that it reproduces every private fact in the historical PM-vs-Vault evaluation. It is intentionally scoped to the failure modes that evaluation raised: project leakage, temporal contradictions, graph provenance, deletion safety, and graph-token visibility.',
    '',
    '</div>',
    '',
  ].join('\n')
}

function runPsql(runDir, sql) {
  const compose = ['compose', '-p', JSON.parse(readFileSync(resolve(runDir, 'manifest.json'), 'utf8')).composeProject,
    '--env-file', resolve(runDir, 'benchmark.env'),
    '-f', resolve(runDir, 'compose.yml'), '-f', resolve(runDir, 'override.yml'),
    'exec', '-T', 'postgres', 'psql', '-U', 'pmuser', '-d', 'persistent_memory', '-At', '-F', '\t', '-c', sql]
  const result = spawnSync('docker', compose, { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not read the isolated benchmark database.')
  return parseRows(result.stdout)
}

export function collectReportInput(runId) {
  if (!runId?.startsWith(RUN_PREFIX)) throw new Error(`Run id must begin with ${RUN_PREFIX}`)
  const runDir = resolve(ROOT, '.local/release-benchmark', runId)
  const statuses = runPsql(runDir, "SELECT graph_status, count(*) FROM memory GROUP BY graph_status ORDER BY graph_status")
    .map(([status, count]) => ({ status, count: Number(count) }))
  const integrity = runPsql(runDir, "SELECT 'memory_count', count(*) FROM memory UNION ALL SELECT 'provenance_count', count(*) FROM graph_episode_provenance UNION ALL SELECT 'lifecycle_pending', count(*) FROM graph_lifecycle_operation WHERE status IN ('pending','processing','failed')")
  const graphUsage = runPsql(runDir, "SELECT count(*), COALESCE(sum(tokens_in), 0), COALESCE(sum(tokens_out), 0) FROM graph_usage_event")
  const models = runPsql(runDir, "SELECT service, model, sum(requests), sum(tokens_in), sum(tokens_out) FROM model_usage_rollup GROUP BY service, model ORDER BY service, model")
    .map(([service, model, requests, input, output]) => ({ service, model, requests: Number(requests), input: Number(input), output: Number(output) }))
  return {
    runId,
    memoryCount: readNumber(integrity, 'memory_count'),
    provenanceCount: readNumber(integrity, 'provenance_count'),
    lifecyclePending: readNumber(integrity, 'lifecycle_pending'),
    memoryStatuses: statuses,
    graphUsage: { events: Number(graphUsage[0]?.[0] ?? 0), input: Number(graphUsage[0]?.[1] ?? 0), output: Number(graphUsage[0]?.[2] ?? 0) },
    models,
  }
}

function main() {
  const input = args(process.argv.slice(2))
  if (!input.run) throw new Error(usage())
  const output = resolve(ROOT, input.output ?? '.local/benchmark-results/release-quality-latest.md')
  const report = renderReport(collectReportInput(input.run))
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, report, 'utf8')
  process.stdout.write(`${output}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main()
