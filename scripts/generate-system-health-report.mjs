#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateSystemHealth, renderSystemHealthReport } from './system-health-report.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const evidenceArg = valueAfter('--evidence')
if (!evidenceArg || evidenceArg.startsWith('--')) throw new Error('Supply --evidence <path> with measured 1.0.0 evidence; earlier release results cannot certify the first public release.')
const evidencePath = resolve(root, evidenceArg)
const outputPath = resolve(root, valueAfter('--output', 'documentation/benchmark_reports/1.0.0-system-health.md'))
const allowAttention = args.includes('--allow-attention')
const expectations = JSON.parse(readFileSync(resolve(root, 'scripts/release-benchmark/specs/1.0.0.json'), 'utf8'))
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
const evaluated = evaluateSystemHealth({ expectations, evidence })
if (evaluated.status !== 'pass' && !allowAttention) throw new Error(`Refusing to publish an incomplete System Health Report: ${evaluated.issues.join(' ')}`)
writeFileSync(outputPath, renderSystemHealthReport({ expectations, evidence }), 'utf8')
process.stdout.write(`${outputPath}\n`)
