#!/usr/bin/env node
/**
 * Completes a sanitized isolated System Health artifact with repeatable static
 * suite evidence and, after a real browser review, the two manual Chrome gates.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)

export const STATIC_SUITES = [
  {
    name: 'MCP surface and recall contracts',
    command: ['npm', 'run', 'test:mcp'],
    gates: ['graph.personal-general'],
  },
  {
    name: 'API memory lifecycle contracts',
    command: ['npm', 'run', 'test:api'],
    gates: ['graph.named-project-scope', 'memory.primary-delete-guard'],
  },
  {
    name: 'Worker migration and retention contracts',
    command: ['npm', 'run', 'test:worker'],
    gates: ['memory.verification-retired', 'graph.migration-recovery'],
    proofTypes: { 'graph.migration-recovery': 'deterministic-contract' },
  },
  {
    name: 'Graphiti telemetry contract',
    command: ['npm', 'run', 'test:graphiti-usage'],
    gates: ['graph.usage-telemetry'],
  },
  {
    name: 'Updater version and progress contracts',
    command: ['npm', 'run', 'test:update-runner'],
    gates: ['updater.version-and-progress'],
  },
  {
    name: 'Candidate engineering suite',
    command: ['npm', 'run', 'typecheck'],
    gates: [],
  },
  {
    name: 'Candidate root test suite',
    command: ['npm', 'test'],
    gates: [],
  },
  {
    name: 'Graphiti primary and non-primary cascade fixture',
    command: ['npm', 'run', 'test:graphiti-cascade'],
    gates: [],
  },
  {
    name: 'Release-upgrade contract',
    command: ['npm', 'run', 'validate:release-upgrade'],
    gates: [],
  },
  {
    name: 'Documentation build and navigation',
    command: ['npm', 'run', 'docs:build'],
    gates: [],
  },
]

function commandLabel(command) {
  return command.join(' ')
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence') values.evidence = argv[++index]
    if (argv[index] === '--run-static') values.runStatic = true
    if (argv[index] === '--chrome-evidence') values.chromeEvidence = argv[++index]
  }
  return values
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function upsertSuite(suites, result) {
  const index = suites.findIndex((suite) => suite.name === result.name)
  if (index >= 0) suites[index] = result
  else suites.push(result)
}

function markGate(gates, id, status, evidence, proofType) {
  const gate = gates.find((candidate) => candidate.id === id)
  if (!gate) throw new Error(`Expected gate ${id} is missing from the evidence artifact.`)
  Object.assign(gate, { status, evidence, durationMs: 0, retries: 0, ...(proofType ? { proofType } : {}) })
}

export function completeEvidence({ evidence, staticResults = [], chromeEvidence }) {
  const completed = clone(evidence)
  completed.suites ??= []
  completed.gates ??= []
  const byName = new Map(staticResults.map((result) => [result.name, result]))
  const engineeringResults = []

  for (const suite of STATIC_SUITES) {
    const result = byName.get(suite.name)
    if (!result) continue
    upsertSuite(completed.suites, result)
    for (const gate of suite.gates) {
      markGate(completed.gates, gate, result.status, result.command, suite.proofTypes?.[gate])
    }
    if (suite.name.startsWith('Candidate ') || suite.name.startsWith('Graphiti primary') || suite.name === 'Release-upgrade contract' || suite.name === 'Documentation build and navigation') {
      engineeringResults.push(result)
    }
  }

  if (engineeringResults.length) {
    const allEngineeringPassed = engineeringResults.length === 5 && engineeringResults.every((result) => result.status === 'pass')
    markGate(
      completed.gates,
      'engineering.candidate-suite',
      allEngineeringPassed ? 'pass' : 'fail',
      allEngineeringPassed ? 'candidate typecheck, root tests, Graphiti cascade, release-upgrade, and documentation build all passed' : 'one or more required engineering suites failed or were not collected',
    )
  }

  if (chromeEvidence) {
    markGate(completed.gates, 'workers.cadence-ui', 'pass', chromeEvidence)
    markGate(completed.gates, 'report.chrome-rendering', 'pass', chromeEvidence)
  }
  return completed
}

function runSuite(suite) {
  const started = Date.now()
  const result = spawnSync(suite.command[0], suite.command.slice(1), { cwd: root, stdio: 'inherit' })
  return {
    name: suite.name,
    command: commandLabel(suite.command),
    status: result.status === 0 ? 'pass' : 'fail',
    passed: result.status === 0 ? 1 : 0,
    failed: result.status === 0 ? 0 : 1,
    skipped: 0,
    durationMs: Date.now() - started,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.evidence) throw new Error('Usage: node scripts/complete-system-health-evidence.mjs --evidence <sanitized-artifact> [--run-static] [--chrome-evidence <summary>]')
  const path = resolve(root, args.evidence)
  const evidence = JSON.parse(readFileSync(path, 'utf8'))
  const staticResults = args.runStatic ? STATIC_SUITES.map(runSuite) : []
  const completed = completeEvidence({ evidence, staticResults, chromeEvidence: args.chromeEvidence })
  writeFileSync(path, `${JSON.stringify(completed, null, 2)}\n`, 'utf8')
  if (staticResults.some((result) => result.status !== 'pass')) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main()
