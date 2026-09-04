import assert from 'node:assert/strict'
import test from 'node:test'
import { compareP0Evidence, renderComparison } from './p0-token-quality-comparison.mjs'

function evidence(label, values = {}) {
  return {
    schemaVersion: 1,
    label,
    identity: { corpusHash: 'p0-token-quality-v1' },
    recall: {
      queryCount: 24,
      leakageCount: 0,
      quality: { expectedMemoryHitRate: 1, meanReciprocalRank: 0.8 },
      recallMetrics: {
        resultBytes: { total: label === 'baseline' ? 100_000 : 50_000, p50: 8_000, p95: 12_000, max: 20_000 },
        estimatedTokens: { total: label === 'baseline' ? 25_000 : 12_000, p50: 2_000, p95: 3_000, max: 5_000 },
        facts: { duplicateFactBytes: label === 'baseline' ? 50_000 : 0 },
        danglingFactRefs: 0,
      },
    },
    agent: { status: 'pass', sampleCount: 6, passed: 6, inputTokens: label === 'baseline' ? 10_000 : 6_000 },
    usage: label === 'baseline' ? [] : [
      { operation: 'memory-update-metadata-only', service: 'fact-extraction', tokensIn: 10, tokensOut: 1 },
      { operation: 'memory-update', service: 'embeddings', tokensIn: 10, tokensOut: 0 },
      { operation: 'memory-update', service: 'graphiti', tokensIn: 10, tokensOut: 1 },
    ],
    ...values,
  }
}

test('passes only when token savings and quality invariants are both satisfied', () => {
  const result = compareP0Evidence(evidence('baseline'), evidence('after'))
  assert.equal(result.status, 'pass')
  assert.match(renderComparison(result), /Status: \*\*PASS\*\*/)
})

test('fails a compact response that loses quality or exceeds the hard cap', () => {
  const after = evidence('after')
  after.recall.quality.expectedMemoryHitRate = 0.95
  after.recall.recallMetrics.resultBytes.max = 30_000
  const result = compareP0Evidence(evidence('baseline'), after)
  assert.equal(result.status, 'fail')
  assert.equal(result.checks.find((check) => check.id === 'recall.hard-cap').pass, false)
  assert.equal(result.checks.find((check) => check.id === 'quality.expected-memory-hits').pass, false)
})

test('allows minor live-rank variance but fails a material MRR regression', () => {
  const baseline = evidence('baseline')
  baseline.recall.quality.meanReciprocalRank = 0.84

  const withinTolerance = evidence('after')
  withinTolerance.recall.quality.meanReciprocalRank = 0.811
  expectCheck(compareP0Evidence(baseline, withinTolerance), 'quality.mrr-stability', true)

  const materialRegression = evidence('after')
  materialRegression.recall.quality.meanReciprocalRank = 0.80
  const result = compareP0Evidence(baseline, materialRegression)
  assert.equal(result.status, 'fail')
  expectCheck(result, 'quality.mrr-stability', false)
})

function expectCheck(result, id, pass) {
  assert.equal(result.checks.find((check) => check.id === id)?.pass, pass)
}
