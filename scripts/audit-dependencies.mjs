import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation } from './host-runtime.mjs'

export function auditIssues(report, status) {
  const counts = report?.metadata?.vulnerabilities
  if (report?.error || report?.auditReportVersion !== 2 || !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || !counts || !['info', 'low', 'moderate', 'high', 'critical', 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    || Object.keys(report.vulnerabilities).length !== counts.total
    || ['info', 'low', 'moderate', 'high', 'critical'].reduce((sum, key) => sum + counts[key], 0) !== counts.total) {
    return ['The registry did not return a complete security audit.']
  }
  if (counts.total) return Object.entries(report.vulnerabilities).map(([name, item]) => `${name}: ${item.severity ?? 'unknown'} security finding`)
  return status === 0 ? [] : ['The security audit command did not succeed.']
}

export function auditDependencies({ root = fileURLToPath(new URL('../', import.meta.url)), run = spawnSync } = {}) {
  const issues = []
  for (const directory of ['', 'apps/dashboard', 'apps/onboard', 'apps/documentation']) {
    const invocation = npmInvocation(['audit', '--json', '--package-lock-only', '--audit-level=low', '--include=dev', '--include=optional', '--include=peer'])
    const result = run(invocation.command, invocation.args, { cwd: resolve(root, directory), encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
    let report
    try { report = JSON.parse(result.stdout) } catch { /* Missing/invalid evidence must fail closed. */ }
    const found = auditIssues(report, result.status)
    if (found.length) issues.push(...found.map(issue => `${directory || 'workspace'}: ${issue}`))
    else console.log(`[OK] ${directory || 'workspace'}: no reported npm vulnerabilities, including development dependencies.`)
  }
  if (issues.length) throw new Error(`Dependency security checks failed:\n${issues.join('\n')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { auditDependencies() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
