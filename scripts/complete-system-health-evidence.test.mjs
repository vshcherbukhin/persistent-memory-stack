import assert from 'node:assert/strict'
import test from 'node:test'
import { completeEvidence, STATIC_SUITES } from './complete-system-health-evidence.mjs'

function evidence() {
  return {
    gates: [
      ...STATIC_SUITES.flatMap((suite) => suite.gates).filter((id, index, all) => all.indexOf(id) === index),
      'engineering.candidate-suite', 'workers.cadence-ui', 'report.chrome-rendering',
    ].map((id) => ({ id, status: 'not-run', evidence: 'not run', proofType: id === 'workers.cadence-ui' || id === 'report.chrome-rendering' ? 'manual-chrome' : id === 'graph.migration-recovery' ? 'integration' : id === 'engineering.candidate-suite' ? 'build-static' : 'deterministic-contract' })),
    suites: [],
  }
}

function passingResults() {
  return STATIC_SUITES.map((suite) => ({ name: suite.name, command: suite.command.join(' '), status: 'pass', passed: 1, failed: 0, skipped: 0, durationMs: 1 }))
}

test('marks only exact suite-backed gates and requires every engineering suite', () => {
  const completed = completeEvidence({ evidence: evidence(), staticResults: passingResults() })
  assert.equal(completed.gates.find((gate) => gate.id === 'graph.personal-general').status, 'pass')
  assert.equal(completed.gates.find((gate) => gate.id === 'engineering.candidate-suite').status, 'pass')

  const missingEngineering = completeEvidence({ evidence: evidence(), staticResults: passingResults().slice(0, -1) })
  assert.equal(missingEngineering.gates.find((gate) => gate.id === 'engineering.candidate-suite').status, 'fail')
})

test('manual Chrome gates remain not-run until real browser evidence is supplied', () => {
  const beforeChrome = completeEvidence({ evidence: evidence(), staticResults: [] })
  assert.equal(beforeChrome.gates.find((gate) => gate.id === 'report.chrome-rendering').status, 'not-run')

  const afterChrome = completeEvidence({ evidence: evidence(), chromeEvidence: 'real Chrome extension review at wide and narrow widths' })
  assert.equal(afterChrome.gates.find((gate) => gate.id === 'workers.cadence-ui').status, 'pass')
  assert.equal(afterChrome.gates.find((gate) => gate.id === 'report.chrome-rendering').status, 'pass')
})

test('ties direct graph project scope to the API contract suite', () => {
  const api = STATIC_SUITES.find((suite) => suite.name === 'API memory lifecycle contracts')
  const mcp = STATIC_SUITES.find((suite) => suite.name === 'MCP surface and recall contracts')
  assert.equal(api?.gates.includes('graph.named-project-scope'), true)
  assert.equal(mcp?.gates.includes('graph.named-project-scope'), false)
})
