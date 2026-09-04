import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { evaluateSystemHealth, renderSystemHealthReport } from './system-health-report.mjs'

const expectations = JSON.parse(
  readFileSync(new URL('./release-benchmark/specs/4.0.30.json', import.meta.url), 'utf8'),
)

function passingEvidence() {
  return {
    schemaVersion: 1,
    release: '4.0.30',
    identity: {
      candidate: 'dev@synthetic',
      corpusHash: 'synthetic-corpus',
      startedAt: '2026-07-17T12:00:00.000Z',
      completedAt: '2026-07-17T12:01:00.000Z',
    },
    gates: expectations.gates.map((gate) => ({
      id: gate.id,
      status: gate.required === false ? 'not-measured' : 'pass',
      proofType: gate.proofType,
      evidence: gate.required === false ? 'explicitly deferred for this release' : 'synthetic unit evidence',
      durationMs: 10,
      retries: 0,
    })),
    operations: [
      { name: 'recall', samples: 24, acknowledgementMs: { p50: 12, p95: 21, max: 30 }, convergenceMs: null, successCount: 24, failureCount: 0 },
    ],
    queries: [
      { name: 'timeline and contradiction', samples: 24, leakageCount: 0, expectedEvidence: 'timeline and contradictions', observed: 'passed' },
    ],
    usage: [
      { operation: 'recall-single', service: 'embeddings', model: 'local', requests: 1, tokensIn: 10, tokensOut: 0 },
    ],
    suites: [{ name: 'root tests', command: 'npm test', status: 'pass', passed: 1, failed: 0, skipped: 0, durationMs: 10 }],
    cleanup: { status: 'pass', credentialsRemoved: true, volumesRemoved: true, derivedRowsRemaining: 0 },
    limitations: ['Synthetic evidence only.'],
  }
}

test('renders a pass only when every required release gate supplies matching evidence', () => {
  const evidence = passingEvidence()
  const result = evaluateSystemHealth({ expectations, evidence })
  const report = renderSystemHealthReport({ expectations, evidence })

  assert.equal(result.status, 'pass')
  assert.match(report, /# 4\.0\.30 System Health Report/)
  assert.match(report, /<h2>Release state: Pass<\/h2>/)
  assert.match(report, /<h2>System boundary at execution<\/h2>/)
  assert.doesNotMatch(report, /## Release state/)
  assert.match(report, /required checks passed/)
  assert.match(report, /What the agent receives from recall/)
  assert.match(report, /Measured request behaviour/)
  assert.match(report, /Release capability matrix/)
  assert.match(report, /Synthetic evidence only\./)
})

test('fails closed when a required release gate is absent or changes proof type', () => {
  const missingGate = passingEvidence()
  missingGate.gates = missingGate.gates.slice(1)
  const proofMismatch = passingEvidence()
  proofMismatch.gates[0].proofType = 'manual-chrome'

  assert.equal(evaluateSystemHealth({ expectations, evidence: missingGate }).status, 'attention')
  assert.equal(evaluateSystemHealth({ expectations, evidence: proofMismatch }).status, 'attention')
})

test('fails closed when release identity or required cleanup evidence is invalid', () => {
  const wrongRelease = passingEvidence()
  wrongRelease.release = '4.0.31'
  const failedCleanup = passingEvidence()
  failedCleanup.cleanup.status = 'fail'

  assert.equal(evaluateSystemHealth({ expectations, evidence: wrongRelease }).status, 'attention')
  assert.equal(evaluateSystemHealth({ expectations, evidence: failedCleanup }).status, 'attention')
})

test('fails closed when query or usage measurements are malformed', () => {
  const malformedQuery = passingEvidence()
  malformedQuery.queries[0].leakageCount = -1
  const malformedUsage = passingEvidence()
  malformedUsage.usage[0].tokensIn = 'unknown'

  assert.equal(evaluateSystemHealth({ expectations, evidence: malformedQuery }).status, 'attention')
  assert.equal(evaluateSystemHealth({ expectations, evidence: malformedUsage }).status, 'attention')
})

test('fails closed when a claimed measurement has zero evidence or inconsistent outcomes', () => {
  const zeroSamples = passingEvidence()
  zeroSamples.operations[0].samples = 0
  zeroSamples.operations[0].successCount = 0
  const zeroRequests = passingEvidence()
  zeroRequests.usage[0].requests = 0
  const inconsistentOutcomes = passingEvidence()
  inconsistentOutcomes.operations[0].successCount = 23

  assert.equal(evaluateSystemHealth({ expectations, evidence: zeroSamples }).status, 'attention')
  assert.equal(evaluateSystemHealth({ expectations, evidence: zeroRequests }).status, 'attention')
  assert.equal(evaluateSystemHealth({ expectations, evidence: inconsistentOutcomes }).status, 'attention')
})

test('rejects unsafe evidence without publishing a secret or host path', () => {
  const unsafe = passingEvidence()
  unsafe.suites[0].command = 'psql postgresql://pm_user:secret@localhost/private'

  const report = renderSystemHealthReport({ expectations, evidence: unsafe })
  assert.equal(evaluateSystemHealth({ expectations, evidence: unsafe }).status, 'attention')
  assert.doesNotMatch(report, /postgresql:\/\//)
})

test('escapes HTML and Markdown controls from evidence before rendering documentation', () => {
  const unsafe = passingEvidence()
  unsafe.gates[0].evidence = '<script>alert(1)</script> ![image](https://example.com/a.png)'

  const report = renderSystemHealthReport({ expectations, evidence: unsafe })
  assert.equal(evaluateSystemHealth({ expectations, evidence: unsafe }).status, 'pass')
  assert.doesNotMatch(report, /<script>/)
  assert.doesNotMatch(report, /!\[image\]\(https:\/\/example\.com/)
  assert.match(report, /&lt;script&gt;/)
})

test('maps every 4.0.30 capability to required evidence or an explicit deferral', () => {
  const ids = new Set(expectations.gates.map((gate) => gate.id))
  for (const id of [
    'retrieval.relevance',
    'retrieval.multi-hop-context',
    'retrieval.duplicate-occupancy',
    'retrieval.distractor-noise',
    'validation.truth-judgement',
    'memory.verification-retired',
    'workers.cadence-ui',
  ]) {
    assert.equal(ids.has(id), true, `${id} must be declared in the release capability matrix`)
  }
  const deferredTruthValidation = expectations.gates.find((gate) => gate.id === 'validation.truth-judgement')
  assert.deepEqual(deferredTruthValidation, {
    id: 'validation.truth-judgement',
    expected: 'Automated factual-truth validation is deliberately deferred; provenance and confidence are not truth certification.',
    proofType: 'not-measured',
    required: false,
  })
})

test('root test command retains dashboard coverage alongside System Health coverage', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(packageJson.scripts.test, /(?:^|&& )npm run test:dashboard(?: &&|$)/)
  assert.match(packageJson.scripts.test, /(?:^|&& )npm run test:system-health-report(?: &&|$)/)
})

test('the isolated benchmark does not leave a completed report with a stale phase placeholder', () => {
  const runner = readFileSync(new URL('./run-system-health-benchmark.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(runner, /Cleanup and final documentation rendering are completed in later release phases/)
})
