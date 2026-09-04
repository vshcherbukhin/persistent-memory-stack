#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const ZERO_USAGE_OPERATIONS = [
  'memory-update-exact-noop',
  'memory-update-session-only',
  'memory-update-same-project',
  'memory-update-identical-metadata',
]

function percentReduction(before, after) {
  if (before <= 0) return after <= 0 ? 1 : 0
  return (before - after) / before
}

function usageFor(evidence, operation, service) {
  return (evidence.usage ?? [])
    .filter((row) => row.operation === operation && (!service || row.service === service))
    .reduce((total, row) => total + row.tokensIn + row.tokensOut, 0)
}

export function compareP0Evidence(baseline, after) {
  const checks = []
  const add = (id, pass, evidence) => checks.push({ id, pass, evidence })
  const beforeRecall = baseline.recall?.recallMetrics
  const afterRecall = after.recall?.recallMetrics
  const sameCorpus = baseline.identity?.corpusHash === after.identity?.corpusHash
  add('identity.same-corpus', sameCorpus, `${baseline.identity?.corpusHash ?? 'missing'} -> ${after.identity?.corpusHash ?? 'missing'}`)
  add('recall.query-count', baseline.recall?.queryCount === after.recall?.queryCount && after.recall?.queryCount === 24, `${baseline.recall?.queryCount ?? 0} -> ${after.recall?.queryCount ?? 0}`)
  add('recall.project-isolation', baseline.recall?.leakageCount === 0 && after.recall?.leakageCount === 0, `${baseline.recall?.leakageCount ?? 'missing'} -> ${after.recall?.leakageCount ?? 'missing'}`)
  add('recall.hard-cap', afterRecall?.resultBytes?.max <= 24_576, `${afterRecall?.resultBytes?.max ?? 'missing'} bytes`)
  add('recall.soft-target', afterRecall?.resultBytes?.p95 <= 16_384, `${afterRecall?.resultBytes?.p95 ?? 'missing'} bytes p95`)
  const byteReduction = percentReduction(beforeRecall?.resultBytes?.total ?? 0, afterRecall?.resultBytes?.total ?? 0)
  add('recall.byte-reduction', byteReduction >= 0.40, `${(byteReduction * 100).toFixed(1)}%`)
  const tokenReduction = percentReduction(beforeRecall?.estimatedTokens?.total ?? 0, afterRecall?.estimatedTokens?.total ?? 0)
  add('recall.token-reduction', tokenReduction >= 0.35, `${(tokenReduction * 100).toFixed(1)}%`)
  const duplicateReduction = percentReduction(beforeRecall?.facts?.duplicateFactBytes ?? 0, afterRecall?.facts?.duplicateFactBytes ?? 0)
  add('recall.duplicate-byte-reduction', duplicateReduction >= 0.80, `${(duplicateReduction * 100).toFixed(1)}%`)
  add('recall.reference-integrity', afterRecall?.danglingFactRefs === 0, `${afterRecall?.danglingFactRefs ?? 'missing'} dangling refs`)
  add('quality.expected-memory-hits', after.recall?.quality?.expectedMemoryHitRate >= baseline.recall?.quality?.expectedMemoryHitRate && after.recall?.quality?.expectedMemoryHitRate === 1, `${baseline.recall?.quality?.expectedMemoryHitRate ?? 'missing'} -> ${after.recall?.quality?.expectedMemoryHitRate ?? 'missing'}`)
  const baselineMrr = baseline.recall?.quality?.meanReciprocalRank ?? 0
  const afterMrr = after.recall?.quality?.meanReciprocalRank ?? 0
  const mrrDelta = afterMrr - baselineMrr
  add('quality.mrr-floor', afterMrr >= 0.80, `${afterMrr} (minimum 0.80)`)
  add('quality.mrr-stability', mrrDelta >= -0.03, `${baselineMrr} -> ${afterMrr} (delta ${mrrDelta.toFixed(4)}, tolerance -0.03)`)
  add('quality.agent-sample', baseline.agent?.status === 'pass' && after.agent?.status === 'pass' && baseline.agent?.passed === after.agent?.passed, `${baseline.agent?.passed ?? 0}/${baseline.agent?.sampleCount ?? 0} -> ${after.agent?.passed ?? 0}/${after.agent?.sampleCount ?? 0}`)
  const agentTokenReduction = percentReduction(baseline.agent?.inputTokens ?? 0, after.agent?.inputTokens ?? 0)
  add('quality.agent-input-reduction', agentTokenReduction >= 0.35, `${(agentTokenReduction * 100).toFixed(1)}%`)

  for (const operation of ZERO_USAGE_OPERATIONS) {
    const tokens = usageFor(after, operation)
    add(`updates.${operation}.zero-model-usage`, tokens === 0, `${tokens} tokens`)
  }
  add('updates.metadata-only.no-embedding', usageFor(after, 'memory-update-metadata-only', 'embeddings') === 0, `${usageFor(after, 'memory-update-metadata-only', 'embeddings')} tokens`)
  add('updates.metadata-only.no-graphiti', usageFor(after, 'memory-update-metadata-only', 'graphiti') === 0, `${usageFor(after, 'memory-update-metadata-only', 'graphiti')} tokens`)
  add('updates.metadata-only.validated', usageFor(after, 'memory-update-metadata-only', 'fact-extraction') > 0, `${usageFor(after, 'memory-update-metadata-only', 'fact-extraction')} tokens`)
  add('updates.content-change.embedding-preserved', usageFor(after, 'memory-update', 'embeddings') > 0, `${usageFor(after, 'memory-update', 'embeddings')} tokens`)
  add('updates.content-change.graph-preserved', usageFor(after, 'memory-update', 'graphiti') > 0, `${usageFor(after, 'memory-update', 'graphiti')} tokens`)

  return {
    schemaVersion: 1,
    status: checks.every((check) => check.pass) ? 'pass' : 'fail',
    summary: { byteReduction, tokenReduction, duplicateReduction, agentTokenReduction, mrrDelta },
    checks,
  }
}

export function renderComparison(result) {
  return [
    '# P0 Token and Memory Quality Comparison',
    '',
    `Status: **${result.status === 'pass' ? 'PASS' : 'FAIL'}**`,
    '',
    `- Recall byte reduction: ${(result.summary.byteReduction * 100).toFixed(1)}%`,
    `- Recall token reduction: ${(result.summary.tokenReduction * 100).toFixed(1)}%`,
    `- Duplicate-fact byte reduction: ${(result.summary.duplicateReduction * 100).toFixed(1)}%`,
    `- Agent input-token reduction: ${(result.summary.agentTokenReduction * 100).toFixed(1)}%`,
    `- Mean reciprocal rank delta: ${result.summary.mrrDelta.toFixed(4)}`,
    '',
    '| Gate | Result | Evidence |',
    '|---|---|---|',
    ...result.checks.map((check) => `| ${check.id} | ${check.pass ? 'pass' : 'FAIL'} | ${String(check.evidence).replaceAll('|', '\\|')} |`),
    '',
  ].join('\n')
}

function args(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index]?.startsWith('--')) continue
    values[argv[index].slice(2)] = argv[index + 1]
    index += 1
  }
  return values
}

function main() {
  const input = args(process.argv.slice(2))
  const baselinePath = resolve(ROOT, input.baseline ?? '.local/benchmark-results/p0-token-quality-baseline.json')
  const afterPath = resolve(ROOT, input.after ?? '.local/benchmark-results/p0-token-quality-after.json')
  const jsonPath = resolve(ROOT, input.json ?? '.local/benchmark-results/p0-token-quality-comparison.json')
  const markdownPath = resolve(ROOT, input.markdown ?? '.local/benchmark-results/p0-token-quality-comparison.md')
  const result = compareP0Evidence(JSON.parse(readFileSync(baselinePath, 'utf8')), JSON.parse(readFileSync(afterPath, 'utf8')))
  mkdirSync(dirname(jsonPath), { recursive: true })
  mkdirSync(dirname(markdownPath), { recursive: true })
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  writeFileSync(markdownPath, `${renderComparison(result)}\n`, 'utf8')
  process.stdout.write(`${markdownPath}\n`)
  if (result.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main()
