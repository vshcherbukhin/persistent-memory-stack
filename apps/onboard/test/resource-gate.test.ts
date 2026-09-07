import { describe, expect, it } from 'vitest'
import { resourceGate } from '../server/resource-gate.js'
import { GiB, type ResourceSnapshot } from '../shared/resource-policy.js'

function fixture(): ResourceSnapshot {
  const disk = { path: '/data', resolvedPath: '/data', filesystemId: 'disk0', status: 'ok' as const, totalBytes: 500 * GiB, freeBytes: 70 * GiB }
  return { capturedAt: '2026-09-07T00:00:00Z', host: { platform: 'darwin', arch: 'arm64', cpuCount: 8, totalMemoryBytes: 8 * GiB, freeMemoryBytes: 3 * GiB }, installDisk: disk, ollamaDisk: disk, dockerHostDisk: disk, docker: { status: 'ok', context: 'local', totalMemoryBytes: 4 * GiB, cpuCount: 4, arch: 'arm64', storageFreeBytes: 50 * GiB } }
}
const api = { provider: 'openai', model: 'text-embedding-3-small' }
describe('execution resource gate', () => {
  it('allows an acknowledged 8 GiB API installation while forbidding local loading', () => {
    expect(resourceGate(fixture(), api, true)).toBeNull()
    expect(resourceGate(fixture(), { provider: 'ollama', model: 'nomic-embed-text' }, true)).toContain('Installation requirements are not met')
  })
  it('cannot waive a newly exhausted disk with a stale acknowledgement', () => {
    const snapshot = fixture()
    snapshot.installDisk.freeBytes = 20 * GiB
    expect(resourceGate(snapshot, api, true)).toContain('at least 35 GiB')
  })
  it('requires explicit acknowledgement of warnings even if minima pass', () => {
    expect(resourceGate(fixture(), api)).toContain('Review and acknowledge')
  })
  it('fails closed if the base RAM or measured filesystem cannot be checked', () => {
    const snapshot = fixture()
    snapshot.host.totalMemoryBytes = null
    snapshot.installDisk.status = 'unknown'
    expect(resourceGate(snapshot, api, true)).toContain('could not be measured')
  })
})
