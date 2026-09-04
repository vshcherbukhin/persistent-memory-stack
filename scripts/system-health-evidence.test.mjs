import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateUsageWindow, isCanonicalUuid, summarizeOperation } from './system-health-evidence.mjs'

test('accepts only a canonical five-segment UUID for telemetry correlation', () => {
  assert.equal(isCanonicalUuid('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isCanonicalUuid('11111111-1111-4111-111111111111'), false)
  assert.equal(isCanonicalUuid('not-a-uuid'), false)
})

test('summarizes agent acknowledgement separately from derived-state convergence', () => {
  const result = summarizeOperation('memory-update', [
    { acknowledgementMs: 12, convergenceMs: 120 },
    { acknowledgementMs: 18, convergenceMs: 180 },
    { acknowledgementMs: 24, convergenceMs: 240 },
  ])

  assert.deepEqual(result, {
    name: 'memory-update',
    samples: 3,
    acknowledgementMs: { p50: 18, p95: 24, max: 24 },
    convergenceMs: { p50: 180, p95: 240, max: 240 },
    successCount: 3,
    failureCount: 0,
  })
})

test('marks failed samples while preserving acknowledged and converged counts', () => {
  const result = summarizeOperation('memory-delete', [
    { acknowledgementMs: 8, convergenceMs: 90 },
    { acknowledgementMs: 10, error: 'lifecycle did not converge' },
  ])

  assert.equal(result.samples, 2)
  assert.equal(result.successCount, 1)
  assert.equal(result.failureCount, 1)
  assert.deepEqual(result.convergenceMs, { p50: 90, p95: 90, max: 90 })
})

test('derives token windows without double-counting overlapping usage rows', () => {
  const before = [
    { service: 'embeddings', model: 'local', requests: 10, tokensIn: 100, tokensOut: 0 },
    { service: 'graphiti', model: 'haiku', requests: 5, tokensIn: 500, tokensOut: 50 },
  ]
  const after = [
    { service: 'embeddings', model: 'local', requests: 12, tokensIn: 130, tokensOut: 0 },
    { service: 'graphiti', model: 'haiku', requests: 7, tokensIn: 700, tokensOut: 90 },
  ]

  assert.deepEqual(aggregateUsageWindow('recall-batch', before, after), [
    { operation: 'recall-batch', service: 'embeddings', model: 'local', requests: 2, tokensIn: 30, tokensOut: 0 },
    { operation: 'recall-batch', service: 'graphiti', model: 'haiku', requests: 2, tokensIn: 200, tokensOut: 40 },
  ])
})

test('rejects a usage counter that goes backwards or has no matching baseline row', () => {
  assert.throws(
    () => aggregateUsageWindow('recall', [{ service: 'embeddings', model: 'local', requests: 2, tokensIn: 20, tokensOut: 0 }], [{ service: 'embeddings', model: 'local', requests: 1, tokensIn: 10, tokensOut: 0 }]),
    /counter moved backwards/,
  )
  assert.throws(
    () => aggregateUsageWindow('recall', [], [{ service: 'embeddings', model: 'local', requests: 1, tokensIn: 10, tokensOut: 0 }]),
    /missing from the baseline/,
  )
})
