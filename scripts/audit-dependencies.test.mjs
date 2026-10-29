import assert from 'node:assert/strict'
import test from 'node:test'
import { auditIssues } from './audit-dependencies.mjs'

const clean = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info:0, low:0, moderate:0, high:0, critical:0, total:0 } } })
test('only a complete successful zero-finding audit passes', () => {
  assert.deepEqual(auditIssues(clean(), 0), [])
  for (const status of [1, null]) assert.notDeepEqual(auditIssues(clean(), status), [])
  for (const report of [undefined, {}, { error: { code:'ENETUNREACH' } }, { ...clean(), auditReportVersion:3 }, { ...clean(), vulnerabilities:5 }]) assert.notDeepEqual(auditIssues(report, 0), [])
})
test('low findings and incomplete counts cannot be hidden by exit status or thresholds', () => {
  const low = clean()
  low.vulnerabilities.katex = { severity:'low' }
  low.metadata.vulnerabilities.low = low.metadata.vulnerabilities.total = 1
  assert.deepEqual(auditIssues(low, 0), ['katex: low security finding'])
  delete low.vulnerabilities.katex
  assert.notDeepEqual(auditIssues(low, 0), [])
  const inconsistent = clean()
  inconsistent.metadata.vulnerabilities.high = 1
  assert.notDeepEqual(auditIssues(inconsistent, 0), [])
})
