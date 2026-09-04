/**
 * Fail-closed evaluator and Markdown renderer for one release System Health
 * Report. It accepts only sanitized evidence supplied by the isolated harness
 * and suite adapters; it never reaches into a user stack or a credential file.
 */

const PROHIBITED_OUTPUT = /(?:postgres(?:ql)?:\/\/|bearer\s+|api[_-]?key|token=|\/Users\/|\/home\/|pmg2_)/i

function safeText(value) {
  const text = String(value ?? '').replace(/[|\r\n]+/g, ' ').trim()
  if (PROHIBITED_OUTPUT.test(text)) return '[redacted]'
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function safePresent(value) {
  const text = safeText(value)
  return text.length > 0 && text !== '[redacted]'
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isPercentile(value) {
  return value === null || value === undefined || (
    typeof value === 'object' && nonNegativeInteger(value.p50) && nonNegativeInteger(value.p95) && nonNegativeInteger(value.max) && value.p50 <= value.p95 && value.p95 <= value.max
  )
}

function issuesForIdentity(evidence, expectations) {
  const issues = []
  if (evidence?.schemaVersion !== expectations?.schemaVersion) issues.push('Evidence schema version does not match the expectation manifest.')
  if (evidence?.release !== expectations?.release) issues.push('Evidence release does not match the expectation manifest.')
  const identity = evidence?.identity
  for (const field of ['candidate', 'corpusHash', 'startedAt', 'completedAt']) {
    if (!safePresent(identity?.[field])) issues.push(`Identity field ${field} is missing or unsafe.`)
  }
  return issues
}

function gateResults(evidence, expectations) {
  const byId = new Map()
  for (const gate of evidence?.gates ?? []) {
    if (byId.has(gate.id)) return { issues: [`Gate ${safeText(gate.id)} was reported more than once.`], results: [] }
    byId.set(gate.id, gate)
  }
  const issues = []
  const results = expectations.gates.map((expected) => {
    const observed = byId.get(expected.id)
    if (expected.required === false && !observed) return { expected, observed: null, status: 'not-measured' }
    const optionalNotMeasured = expected.required === false && observed?.status === 'not-measured' && observed?.proofType === expected.proofType && safePresent(observed?.evidence)
    const status = observed?.status === 'pass' && observed?.proofType === expected.proofType && safePresent(observed?.evidence)
      ? 'pass'
      : optionalNotMeasured
        ? 'not-measured'
        : 'attention'
    if (!observed && expected.required !== false) issues.push(`Required gate ${expected.id} is missing.`)
    else if (observed.proofType !== expected.proofType) issues.push(`Required gate ${expected.id} has proof type ${safeText(observed.proofType)} instead of ${expected.proofType}.`)
    else if (observed.status !== 'pass' && !optionalNotMeasured) issues.push(`Required gate ${expected.id} is ${safeText(observed.status) || 'not reported'}.`)
    else if (!safePresent(observed.evidence)) issues.push(`Required gate ${expected.id} has no safe evidence reference.`)
    return { expected, observed, status }
  })
  for (const id of byId.keys()) {
    if (!expectations.gates.some((gate) => gate.id === id)) issues.push(`Unexpected gate ${safeText(id)} is not declared in the expectation manifest.`)
  }
  return { issues, results }
}

function issuesForMeasurements(evidence) {
  const issues = []
  if (!Array.isArray(evidence?.operations) || evidence.operations.length === 0) issues.push('No operation measurements were supplied.')
  for (const operation of evidence?.operations ?? []) {
    if (!safePresent(operation.name) || !positiveInteger(operation.samples) || !nonNegativeInteger(operation.successCount) || !nonNegativeInteger(operation.failureCount) || operation.successCount + operation.failureCount !== operation.samples || operation.successCount !== operation.samples || !isPercentile(operation.acknowledgementMs) || !isPercentile(operation.convergenceMs)) {
      issues.push(`Operation ${safeText(operation.name) || 'unknown'} is malformed.`)
    }
  }
  if (!Array.isArray(evidence?.queries) || evidence.queries.length === 0) {
    issues.push('No recall quality measurements were supplied.')
  } else {
    for (const query of evidence.queries) {
      if (!safePresent(query.name) || !positiveInteger(query.samples) || !safePresent(query.expectedEvidence) || !safePresent(query.observed) || !nonNegativeInteger(query.leakageCount) || query.leakageCount !== 0) {
        issues.push(`Query measurement ${safeText(query.name) || 'unknown'} is malformed.`)
      }
    }
  }
  if (!Array.isArray(evidence?.usage) || evidence.usage.length === 0) {
    issues.push('No token-usage windows were supplied.')
  } else {
    for (const usage of evidence.usage) {
      if (!safePresent(usage.operation) || !safePresent(usage.service) || !safePresent(usage.model) || !positiveInteger(usage.requests) || !nonNegativeInteger(usage.tokensIn) || !nonNegativeInteger(usage.tokensOut)) {
        issues.push(`Usage window ${safeText(usage.operation) || 'unknown'} is malformed.`)
      }
    }
  }
  if (!Array.isArray(evidence?.suites) || evidence.suites.length === 0) {
    issues.push('No suite evidence was supplied.')
  } else {
    for (const suite of evidence.suites) {
      if (!safePresent(suite.name) || !safePresent(suite.command) || suite.status !== 'pass' || !positiveInteger(suite.passed) || !nonNegativeInteger(suite.failed) || suite.failed !== 0 || !nonNegativeInteger(suite.skipped) || !nonNegativeInteger(suite.durationMs)) {
        issues.push(`Suite ${safeText(suite.name) || 'unknown'} is malformed or did not pass.`)
      }
    }
  }
  const cleanup = evidence?.cleanup
  if (cleanup?.status !== 'pass' || cleanup?.credentialsRemoved !== true || cleanup?.volumesRemoved !== true || cleanup?.derivedRowsRemaining !== 0) {
    issues.push('Isolated benchmark cleanup is incomplete.')
  }
  if (!Array.isArray(evidence?.limitations) || evidence.limitations.length === 0 || evidence.limitations.some((limitation) => !safePresent(limitation))) issues.push('The report must disclose at least one safe limitation.')
  return issues
}

export function evaluateSystemHealth({ expectations, evidence }) {
  const identityIssues = issuesForIdentity(evidence, expectations)
  const { issues: gatesIssues, results } = gateResults(evidence, expectations)
  const measurementIssues = issuesForMeasurements(evidence)
  const issues = [...identityIssues, ...gatesIssues, ...measurementIssues]
  return { status: issues.length === 0 ? 'pass' : 'attention', issues, gateResults: results }
}

function displayPercentiles(value) {
  if (!value) return 'not applicable'
  return `p50 ${value.p50} ms · p95 ${value.p95} ms · max ${value.max} ms`
}

function tableRow(cells) {
  return `| ${cells.map(safeText).join(' | ')} |`
}

export function renderSystemHealthReport({ expectations, evidence }) {
  const result = evaluateSystemHealth({ expectations, evidence })
  const titleStatus = result.status === 'pass' ? 'Pass' : 'Attention required'
  const requiredGates = result.gateResults.filter(({ expected }) => expected.required !== false)
  const passingGates = requiredGates.filter(({ status }) => status === 'pass').length
  const operationSamples = (evidence.operations ?? []).reduce((total, operation) => total + Number(operation.samples ?? 0), 0)
  const querySamples = (evidence.queries ?? []).reduce((total, query) => total + Number(query.samples ?? 0), 0)
  const totalTokens = (evidence.usage ?? []).reduce((total, usage) => total + Number(usage.tokensIn ?? 0) + Number(usage.tokensOut ?? 0), 0)
  const report = [
    '---',
    `nav_title: ${safeText(expectations.release)} system health`,
    'nav_group: benchmark-reports',
    'nav_group_title: Benchmark Reports',
    'nav_group_order: 60',
    'nav_order: 10',
    '---',
    `# ${safeText(expectations.release)} System Health Report`,
    '',
    `<div class="benchmark-report" data-status="${result.status}">`,
    '',
    '<div class="benchmark-report-hero">',
    '<div>',
    '<span class="benchmark-eyebrow">Release evidence</span>',
    `<h2>Release state: ${titleStatus}</h2>`,
    '<p>One synthetic full-stack run plus exact candidate contracts. Each release capability is separately classified as measured, deterministic, integration, build, or browser evidence.</p>',
    '</div>',
    `<span class="benchmark-status benchmark-status-${result.status}">${titleStatus}</span>`,
    '</div>',
    '',
    `<p>Completed: <strong>${safeText(evidence.identity?.completedAt)}</strong><br />Candidate: <code>${safeText(evidence.identity?.candidate)}</code><br />Synthetic corpus: <code>${safeText(evidence.identity?.corpusHash)}</code></p>`,
    '',
    '<p>A pass means every required release capability has the evidence type declared below. It is not a factual-truth, compliance, privacy, security, or clinical certification.</p>',
    '',
    '<div class="benchmark-kpis">',
    `<div><strong>${passingGates} / ${requiredGates.length}</strong><span>required checks passed</span></div>`,
    `<div><strong>${querySamples}</strong><span>live recall queries</span></div>`,
    `<div><strong>${operationSamples}</strong><span>lifecycle samples</span></div>`,
    `<div><strong>${totalTokens.toLocaleString()}</strong><span>measured model tokens</span></div>`,
    '</div>',
    '',
    '<h2>System boundary at execution</h2>',
    '',
    '<div class="benchmark-flow" aria-label="System Health Report execution boundary">',
    '<div><strong>Agent request</strong><span>named project + configured memory surface</span></div>',
    '<div><strong>MCP recall</strong><span>semantic memory, graph, timeline, contradictions</span></div>',
    '<div><strong>Authoritative record</strong><span>Postgres scope and lifecycle authorization</span></div>',
    '<div><strong>Derived state</strong><span>Qdrant, Graphiti/FalkorDB, MinIO evidence</span></div>',
    '</div>',
    '',
    '<p>The named project and configured surface are the first boundary. Personal-only MCP sessions advertise only Personal Memories; Shared is available only after a real connector is configured. PostgreSQL remains authoritative; vector, graph, and file state are derived and independently checked for convergence or removal.</p>',
    '',
    '</div>',
    '',
    '## What the agent receives from recall',
    '',
    'A graph-first `recall_context` response is evaluated as one picture: project-scoped semantic memories, graph facts, entity expansion, a temporal timeline, contradictions/supersession history, and follow-up identifiers. The query table below records the evaluated corpus signals and cross-project leakage count.',
    '',
    '| Query category | Samples | Expected evidence | Observed | Cross-project leakage |',
    '| --- | ---: | --- | --- | ---: |',
    ...(evidence.queries ?? []).map((query) => tableRow([query.name, query.samples ?? 0, query.expectedEvidence, query.observed, query.leakageCount ?? 0])),
    '',
    '## Measured request behaviour',
    '',
    'Acknowledgement is when the MCP/API returns control to the agent. Convergence is when the corresponding derived state is demonstrably searchable or absent; it is intentionally reported separately.',
    '',
    '| Operation | Samples | Success / failure | Agent acknowledgement | Derived-state convergence |',
    '| --- | ---: | ---: | --- | --- |',
    ...(evidence.operations ?? []).map((operation) => tableRow([
      operation.name,
      operation.samples ?? 0,
      `${operation.successCount ?? 0} / ${operation.failureCount ?? 0}`,
      displayPercentiles(operation.acknowledgementMs),
      displayPercentiles(operation.convergenceMs),
    ])),
    '',
    '## Token usage windows',
    '',
    'These are isolated operation or batch windows. Graphiti write telemetry is not added again to an overlapping aggregate rollup.',
    '',
    '| Window | Service / stage | Model | Requests | Input | Output | Total |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...(evidence.usage ?? []).map((usage) => tableRow([
      usage.operation,
      usage.service,
      usage.model,
      usage.requests ?? 0,
      usage.tokensIn ?? 0,
      usage.tokensOut ?? 0,
      Number(usage.tokensIn ?? 0) + Number(usage.tokensOut ?? 0),
    ])),
    '',
    '## Release capability matrix',
    '',
    '| Capability | Expected behaviour | Proof | Status | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...result.gateResults.map(({ expected, observed, status }) => tableRow([
      expected.id,
      expected.expected,
      expected.proofType,
      status,
      observed?.evidence ?? 'missing',
    ])),
    '',
    '## Suite evidence',
    '',
    '| Suite | Status | Passed / failed / skipped | Duration |',
    '| --- | --- | ---: | ---: |',
    ...(evidence.suites ?? []).map((suite) => tableRow([suite.name, suite.status, `${suite.passed ?? 0} / ${suite.failed ?? 0} / ${suite.skipped ?? 0}`, `${suite.durationMs ?? 0} ms`])),
    '',
    '## Cleanup and limitations',
    '',
    `- Isolated cleanup: **${safeText(evidence.cleanup?.status)}**; credentials removed: **${Boolean(evidence.cleanup?.credentialsRemoved)}**; volumes removed: **${Boolean(evidence.cleanup?.volumesRemoved)}**; derived rows remaining: **${Number(evidence.cleanup?.derivedRowsRemaining ?? 0)}**.`,
    ...(evidence.limitations ?? []).map((limitation) => `- Limitation: ${safeText(limitation)}`),
    ...(result.issues.length ? ['', '## Attention required', '', ...result.issues.map((issue) => `- ${safeText(issue)}`)] : []),
    '',
  ]
  return report.join('\n')
}
