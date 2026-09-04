#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateSystemHealth, renderSystemHealthReport } from './system-health-report.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const evidencePath = resolve(root, valueAfter('--evidence', '.local/benchmark-results/4.0.30-system-health.json'))
const outputPath = resolve(root, valueAfter('--output', 'documentation/benchmark_reports/4.0.30-system-health.md'))
const allowAttention = args.includes('--allow-attention')
const expectations = JSON.parse(readFileSync(resolve(root, 'scripts/release-benchmark/specs/4.0.30.json'), 'utf8'))
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
const evaluated = evaluateSystemHealth({ expectations, evidence })
if (evaluated.status !== 'pass' && !allowAttention) throw new Error(`Refusing to publish an incomplete System Health Report: ${evaluated.issues.join(' ')}`)
writeFileSync(outputPath, renderSystemHealthReport({ expectations, evidence }), 'utf8')
process.stdout.write(`${outputPath}\n`)
