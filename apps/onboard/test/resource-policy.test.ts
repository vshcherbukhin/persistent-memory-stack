import { describe, expect, it } from 'vitest'
import { evaluateResources, recommendResources, RESOURCE_MODELS, GiB, type DiskResources, type ResourceSnapshot } from '../shared/resource-policy.ts'

const disk = (id = 'disk0', free = 200): DiskResources => ({ path: '/data', resolvedPath: '/data', filesystemId: id, status: 'ok', totalBytes: 500 * GiB, freeBytes: free * GiB })
const fixture = (): ResourceSnapshot => ({
  capturedAt: '2026-09-07T00:00:00.000Z',
  host: { platform: 'darwin', arch: 'arm64', cpuCount: 8, totalMemoryBytes: 64 * GiB, freeMemoryBytes: 24 * GiB },
  installDisk: disk(), ollamaDisk: disk(), dockerHostDisk: disk(),
  docker: { status: 'ok', totalMemoryBytes: 8 * GiB, cpuCount: 8, arch: 'aarch64', storageFreeBytes: 100 * GiB },
})
const select = (snapshot: ResourceSnapshot, model = 'qwen3-embedding:4b') => evaluateResources(snapshot, { provider: 'ollama', model })

describe('conservative embedding resource policy', () => {
  it('lists the exact supported provider dimensions, including the smallest local model', () => {
    expect(RESOURCE_MODELS.map(({ provider, model, dim }) => [provider, model, dim])).toEqual([
      ['ollama', 'nomic-embed-text', 768], ['ollama', 'qwen3-embedding:0.6b', 1024],
      ['ollama', 'qwen3-embedding:4b', 2560], ['ollama', 'qwen3-embedding:8b', 4096],
      ['openai', 'text-embedding-3-small', 1536], ['openai', 'text-embedding-3-large', 3072],
      ['voyage', 'voyage-4', 1024], ['voyage', 'voyage-4-large', 1024], ['voyage', 'voyage-4-lite', 1024], ['voyage', 'voyage-3-large', 1024],
    ])
  })
  it('recommends a remote API and disables every local model on an 8 GiB Mac', () => {
    const snapshot = fixture()
    snapshot.host.totalMemoryBytes = 8 * GiB
    snapshot.host.freeMemoryBytes = 2.5 * GiB
    snapshot.docker.totalMemoryBytes = 4 * GiB
    const recommendation = recommendResources(snapshot)
    expect(recommendation).toMatchObject({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536, allowed: true, localEnabled: false })
    expect(recommendation.options.filter(option => option.model?.location === 'local').every(option => !option.allowed)).toBe(true)
  })
  it.each([[16, 6, 'nomic-embed-text'], [24, 8, 'qwen3-embedding:0.6b'], [32, 12, 'qwen3-embedding:4b'], [64, 24, 'qwen3-embedding:8b']])('selects the largest recommended model for %s GiB with %s GiB free', (total, free, model) => {
    const snapshot = fixture()
    snapshot.host.totalMemoryBytes = Number(total) * GiB
    snapshot.host.freeMemoryBytes = Number(free) * GiB
    expect(recommendResources(snapshot).model).toBe(model)
  })
  it('keeps unknown Docker storage visible without overriding a well-supported large-host recommendation', () => {
    const snapshot = fixture()
    snapshot.docker.storageFreeBytes = null
    snapshot.dockerHostDisk = null
    const result = recommendResources(snapshot)
    expect(result).toMatchObject({ model: 'qwen3-embedding:8b', allowed: true, requiresAcknowledgement: true })
    expect(select(snapshot).warnings.map(item => item.code)).toEqual(expect.arrayContaining(['docker_storage_unknown', 'docker_host_disk_unknown']))
  })
  it('makes a smaller local option selectable at minimum while recommending the remote fallback', () => {
    const snapshot = fixture()
    snapshot.host.totalMemoryBytes = 12 * GiB
    snapshot.host.freeMemoryBytes = 3 * GiB
    expect(select(snapshot, 'nomic-embed-text')).toMatchObject({ allowed: true, meetsRecommended: false })
    expect(recommendResources(snapshot)).toMatchObject({ provider: 'openai', localEnabled: true })
  })
  it('adds install and model reservations when they use the same filesystem', () => {
    const snapshot = fixture()
    snapshot.installDisk = disk('same', 40)
    snapshot.ollamaDisk = disk('same', 40)
    snapshot.dockerHostDisk = disk('same', 40)
    const result = select(snapshot)
    expect(result.allowed).toBe(false)
    expect(result.blockers.find(item => item.code === 'disk_minimum')?.message).toContain('43 GiB')
  })
  it('checks separate model disks independently', () => {
    const snapshot = fixture()
    snapshot.installDisk = disk('install', 40)
    snapshot.ollamaDisk = disk('models', 9)
    snapshot.dockerHostDisk = disk('install', 40)
    expect(select(snapshot)).toMatchObject({ allowed: true, meetsRecommended: false })
    snapshot.ollamaDisk.freeBytes = 7 * GiB
    expect(select(snapshot).allowed).toBe(false)
  })
  it('combines model and Docker reservations on their shared separate disk', () => {
    const snapshot = fixture()
    snapshot.ollamaDisk = disk('other', 32)
    snapshot.dockerHostDisk = disk('other', 32)
    const result = select(snapshot)
    expect(result.allowed).toBe(false)
    expect(result.blockers.find(item => item.code === 'disk_minimum')?.message).toContain('33 GiB')
  })
  it('does not treat a roomy installation disk as sufficient Docker data space', () => {
    const snapshot = fixture()
    snapshot.dockerHostDisk = disk('docker', 10)
    expect(select(snapshot).blockers.some(item => item.message.startsWith('Docker data filesystem'))).toBe(true)
  })
  it('keeps free Docker Linux storage independent from physical host free space', () => {
    const snapshot = fixture()
    snapshot.docker.storageFreeBytes = 1 * GiB
    expect(select(snapshot).blockers.map(item => item.code)).toContain('docker_disk_minimum')
  })
  it('blocks known host and Docker RAM shortfalls independently', () => {
    const snapshot = fixture()
    snapshot.host.totalMemoryBytes = 16 * GiB
    snapshot.docker.totalMemoryBytes = 3 * GiB
    expect(select(snapshot).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['host_ram_minimum', 'docker_ram_minimum']))
  })
  it('distinguishes minimum Docker CPU allocation from recommended headroom', () => {
    const snapshot = fixture()
    snapshot.docker.cpuCount = 2
    expect(select(snapshot)).toMatchObject({ allowed: true, meetsRecommended: false })
    expect(select(snapshot).warnings.map(item => item.code)).toContain('docker_cpu_recommended')
  })
  it('blocks critical unknown capacities rather than counting them as zero or success', () => {
    const snapshot = fixture()
    snapshot.host.totalMemoryBytes = null
    snapshot.host.freeMemoryBytes = null
    snapshot.installDisk = { ...disk(), status: 'unknown', freeBytes: null }
    snapshot.docker.totalMemoryBytes = null
    expect(select(snapshot).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['host_ram_unknown', 'free_host_ram_unknown', 'filesystem_unknown', 'docker_ram_unknown']))
  })
  it('does not require an Ollama model filesystem for a remote API selection', () => {
    const snapshot = fixture()
    snapshot.ollamaDisk = { ...disk(), status: 'unknown', freeBytes: null }
    expect(evaluateResources(snapshot, { provider: 'openai', model: 'text-embedding-3-small' }).allowed).toBe(true)
    expect(select(snapshot).allowed).toBe(false)
  })
  it('does not allow an unavailable daemon, unsupported architecture, or an unknown model', () => {
    const snapshot = fixture()
    snapshot.docker.status = 'unavailable'
    snapshot.host.arch = 'ia32'
    expect(select(snapshot).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['docker_unavailable', 'host_architecture']))
    expect(evaluateResources(snapshot, { provider: 'ollama', model: 'invented' })).toMatchObject({ allowed: false, model: null })
  })
  it('blocks zero free disk and zero free RAM while distinguishing them from unknown', () => {
    const snapshot = fixture()
    snapshot.host.freeMemoryBytes = 0
    snapshot.installDisk.freeBytes = 0
    expect(select(snapshot).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['free_host_ram_minimum', 'disk_minimum']))
  })
})
