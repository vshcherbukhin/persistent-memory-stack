import test from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from './release-benchmark-report.mjs'

test('release benchmark report renders integrity and token evidence without runtime secrets', () => {
  const report = renderReport({
    runId: 'pm-benchmark-unit-test',
    memoryCount: 9,
    provenanceCount: 9,
    lifecyclePending: 0,
    memoryStatuses: [{ status: 'ok', count: 9 }],
    graphUsage: { events: 45, input: 83_016, output: 5_837 },
    models: [
      { service: 'embeddings', model: 'local', requests: 13, input: 744, output: 0 },
      { service: 'graphiti', model: 'claude-haiku', requests: 45, input: 83_016, output: 5_837 },
    ],
  })

  assert.match(report, /# Release Quality Benchmark Report/)
  assert.match(report, /## Pass/)
  assert.match(report, /\| Graph provenance rows \| 9 \|/)
  assert.match(report, /\| \*\*Graphiti telemetry\*\* \| 45 \| 83016 \| 5837 \| \*\*88853\*\* \|/)
  assert.doesNotMatch(report, /postgres:\/\//i)
  assert.doesNotMatch(report, /token=/i)
})

test('release benchmark report fails its displayed status when graph integrity is incomplete', () => {
  const report = renderReport({
    runId: 'pm-benchmark-unit-test',
    memoryCount: 3,
    provenanceCount: 2,
    lifecyclePending: 1,
    memoryStatuses: [{ status: 'pending', count: 1 }, { status: 'ok', count: 2 }],
    graphUsage: { events: 1, input: 2, output: 3 },
    models: [],
  })
  assert.match(report, /## Attention required/)
})

test('release benchmark report refuses an empty or telemetry-free run', () => {
  const empty = renderReport({
    runId: 'pm-benchmark-unit-test',
    memoryCount: 0,
    provenanceCount: 0,
    lifecyclePending: 0,
    memoryStatuses: [],
    graphUsage: { events: 0, input: 0, output: 0 },
    models: [],
  })
  const failed = renderReport({
    runId: 'pm-benchmark-unit-test',
    memoryCount: 2,
    provenanceCount: 2,
    lifecyclePending: 0,
    memoryStatuses: [{ status: 'failed', count: 1 }, { status: 'ok', count: 1 }],
    graphUsage: { events: 0, input: 0, output: 0 },
    models: [],
  })

  assert.match(empty, /## Attention required/)
  assert.match(failed, /## Attention required/)
})
