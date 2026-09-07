import { describe, expect, it, vi } from 'vitest'
import { dockerDataPathFromSettings, dockerEndpointLocation, parseDockerResources, parseDockerStorageBytes, parseWindowsPhysicalMemoryBytes, readFilesystemResources, readHostResources, readResources, type ResourceProbeIO } from '../server/resources.ts'
import { evaluateResources, GiB } from '../shared/resource-policy.ts'

const stats = { bsize: 4096n, blocks: BigInt(200 * GiB / 4096), bavail: BigInt(100 * GiB / 4096) }
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
const docker = (extra: Record<string, unknown> = {}) => ({ code: 0, stdout: JSON.stringify({ OSType: 'linux', MemTotal: 8 * GiB, NCPU: 4, Architecture: 'aarch64', DockerRootDir: '/var/lib/docker', ...extra }) })
const io = (): ResourceProbeIO => ({
  statfs: vi.fn(async () => stats), device: vi.fn(async () => 'device-1'),
  readText: vi.fn(async () => { throw missing() }), capture: vi.fn(async (_command, args) => args[0] === 'context' ? { code: 0, stdout: JSON.stringify('unix:///var/run/docker.sock') } : docker()),
})
const host = { platform: 'win32', arch: 'x64', cpuCount: 8, totalMemoryBytes: 16 * GiB, freeMemoryBytes: 6 * GiB }

describe('read-only host resource detection', () => {
  it('uses installed Windows modules for a 16 GiB machine while preserving its exact usable and free RAM', async () => {
    const probes = io()
    const capture = probes.capture
    probes.capture = vi.fn(async (command, args, timeout) => command === 'powershell.exe'
      ? { code: 0, stdout: JSON.stringify([String(8 * GiB), String(8 * GiB)]) }
      : capture(command, args, timeout))
    const snapshot = await readResources({ installPath: 'C:/repo', platform: 'win32', home: 'C:/Users/Test', env: {}, host: { ...host, totalMemoryBytes: 16919126016 }, io: probes })
    expect(snapshot.host).toMatchObject({ totalMemoryBytes: 16 * GiB, usableMemoryBytes: 16919126016, freeMemoryBytes: 6 * GiB, memorySource: 'installed-physical' })
    expect(evaluateResources(snapshot, { provider: 'ollama', model: 'qwen3-embedding:0.6b' }).blockers.map(issue => issue.code)).not.toContain('host_ram_minimum')
    const call = vi.mocked(probes.capture).mock.calls.find(([command]) => command === 'powershell.exe')!
    expect(call[1].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(call[1][3]).toContain('Win32_PhysicalMemory -Property Capacity -OperationTimeoutSec 3')
    expect(call[1][3]).not.toContain('SerialNumber')
    expect(call[2]).toBe(5000)
  })
  it('lets an installed 8 GiB Windows machine meet remote RAM minimum while still blocking low free memory', async () => {
    const probes = io()
    const capture = probes.capture
    probes.capture = async (command, args, timeout) => command === 'powershell.exe'
      ? { code: 0, stdout: JSON.stringify([String(8 * GiB)]) }
      : capture(command, args, timeout)
    const snapshot = await readResources({ installPath: 'C:/repo', platform: 'win32', home: 'C:/Users/Test', env: {}, host: { ...host, totalMemoryBytes: 7.75 * GiB, freeMemoryBytes: 2.5 * GiB }, io: probes })
    const selection = { provider: 'openai', model: 'text-embedding-3-small' } as const
    expect(evaluateResources(snapshot, selection).allowed).toBe(true)
    snapshot.host.freeMemoryBytes = GiB
    expect(evaluateResources(snapshot, selection).blockers.map(issue => issue.code)).toContain('free_host_ram_minimum')
    expect(snapshot.host.totalMemoryBytes).toBe(8 * GiB)
  })
  it.each([
    { code: 1, stdout: '' },
    { code: null, stdout: '', timedOut: true },
    { code: 0, stdout: 'unreadable' },
    { code: 0, stdout: '["8589934592"]' },
  ])('falls back conservatively and visibly when physical Windows inventory is unavailable or incomplete: %j', async response => {
    const base = { ...host, totalMemoryBytes: 16919126016 }
    const measured = await readHostResources('win32', vi.fn(async () => response), 100, base)
    expect(measured).toMatchObject({ ...base, usableMemoryBytes: 16919126016, memorySource: 'os-usable', memoryReason: expect.stringContaining('without rounding up') })
    const probes = io()
    probes.capture = vi.fn(async (command, args) => command === 'powershell.exe' ? response : args[0] === 'context' ? { code: 0, stdout: JSON.stringify('npipe:////./pipe/docker_engine') } : docker())
    const snapshot = await readResources({ installPath: 'C:/repo', platform: 'win32', home: 'C:/Users/Test', env: {}, host: base, io: probes })
    const assessment = evaluateResources(snapshot, { provider: 'ollama', model: 'qwen3-embedding:0.6b' })
    expect(assessment.blockers.map(issue => issue.code)).toContain('host_ram_minimum')
    expect(assessment.warnings.map(issue => issue.code)).toContain('host_memory_fallback')
  })
  it('bounds a hung physical-memory probe without changing free RAM', async () => {
    const measured = await readHostResources('win32', () => new Promise(() => {}), 10, host)
    expect(measured).toMatchObject({ totalMemoryBytes: host.totalMemoryBytes, freeMemoryBytes: host.freeMemoryBytes, memorySource: 'os-usable', memoryReason: expect.any(String) })
  })
  it.each(['darwin', 'linux'] as const)('keeps native %s RAM detection and performs no Windows query', async platform => {
    const capture = vi.fn()
    const base = { ...host, platform }
    expect(await readHostResources(platform, capture, 100, base)).toEqual(base)
    expect(capture).not.toHaveBeenCalled()
  })
  it('reports native Windows host and Linux VM capacities separately, preserving Unicode paths', async () => {
    const probes = io()
    const snapshot = await readResources({ installPath: 'C:/Projects/Memory Repo', platform: 'win32', home: 'C:/Users/Тест User', env: { OLLAMA_MODELS: 'D:/Model Store/模型' }, host, io: probes })
    expect(snapshot.host.totalMemoryBytes).toBe(16 * GiB)
    expect(snapshot.docker.totalMemoryBytes).toBe(8 * GiB)
    expect(snapshot.ollamaDisk.path).toBe('D:\\Model Store\\模型')
    expect(snapshot.docker.storageFreeBytes).toBeNull()
    expect(probes.capture).toHaveBeenCalledWith('docker', ['info', '--format', '{{json .}}'], 5000)
    expect(vi.mocked(probes.statfs).mock.calls.flat()).not.toContain('/var/lib/docker')
  })
  it('checks a missing model directory on its nearest existing filesystem without creating it', async () => {
    const probes = io()
    probes.statfs = vi.fn(async path => { if (path !== '/Users/test') throw missing(); return stats })
    const result = await readFilesystemResources('/Users/test/.ollama/models', probes, 'darwin')
    expect(result).toMatchObject({ status: 'ok', resolvedPath: '/Users/test', freeBytes: 100 * GiB, filesystemId: 'device-1' })
    expect(vi.mocked(probes.statfs).mock.calls.map(([path]) => path)).toEqual(['/Users/test/.ollama/models', '/Users/test/.ollama', '/Users/test'])
  })
  it('uses the host default model directory for an empty Ollama override', async () => {
    const snapshot = await readResources({ installPath: '/repo', platform: 'darwin', home: '/Users/test', env: { OLLAMA_MODELS: '' }, host, io: io() })
    expect(snapshot.ollamaDisk.path).toBe('/Users/test/.ollama/models')
  })
  it('does not turn access denial into a capacity measurement on a parent disk', async () => {
    const probes = io()
    probes.statfs = vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    expect(await readFilesystemResources('/locked/models', probes, 'darwin')).toMatchObject({ status: 'unknown', freeBytes: null })
    expect(probes.statfs).toHaveBeenCalledTimes(1)
  })
  it('rejects relative paths and preserves UNC volume identity', async () => {
    const probes = io()
    expect(await readFilesystemResources('models', probes, 'win32')).toMatchObject({ status: 'unknown' })
    expect(probes.statfs).not.toHaveBeenCalled()
    expect(await readFilesystemResources('\\\\server\\models\\模型', probes, 'win32')).toMatchObject({ path: '\\\\server\\models\\模型', status: 'ok' })
  })
  it.each(['\\models', '/models', 'D:models'])('does not measure a Windows current-drive path: %s', async path => {
    const probes = io()
    expect(await readFilesystemResources(path, probes, 'win32')).toMatchObject({ status: 'unknown', reason: expect.stringContaining('fully qualified') })
    expect(probes.statfs).not.toHaveBeenCalled()
    expect(dockerDataPathFromSettings(JSON.stringify({ dataFolder: path }), 'win32', 'C:/Users/test')).toBeNull()
  })
  it('keeps zero free space valid and rejects malformed capacity arithmetic', async () => {
    const probes = io()
    probes.statfs = async () => ({ ...stats, bavail: 0n })
    expect(await readFilesystemResources('/disk', probes, 'linux')).toMatchObject({ status: 'ok', freeBytes: 0 })
    probes.statfs = async () => ({ ...stats, bavail: -1n })
    expect(await readFilesystemResources('/disk', probes, 'linux')).toMatchObject({ status: 'unknown', freeBytes: null })
  })
  it('bounds a hung filesystem probe and reports the unknown measurement', async () => {
    const probes = io()
    probes.statfs = () => new Promise(() => {})
    expect(await readFilesystemResources('/offline', probes, 'linux', 15)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('timed out') })
  })
  it('reads only an explicit Docker host disk location from settings and measures its own filesystem', async () => {
    const probes = io()
    probes.readText = vi.fn(async path => path.endsWith('settings-store.json') ? JSON.stringify({ DataFolder: 'E:\\Docker Space', proxyPassword: 'placeholder-secret-not-returned' }) : '{}')
    probes.device = async path => path.startsWith('E:') ? 'docker-volume' : 'install-volume'
    const snapshot = await readResources({ installPath: 'C:/repo', platform: 'win32', home: 'C:/Users/Test', env: { APPDATA: 'C:/Users/Test/AppData/Roaming' }, host, io: probes })
    expect(snapshot.dockerHostDisk).toMatchObject({ path: 'E:\\Docker Space', filesystemId: 'docker-volume', freeBytes: 100 * GiB })
    expect(JSON.stringify(snapshot)).not.toContain('placeholder-secret')
    expect(snapshot.docker.storageFreeBytes).toBeNull()
  })
  it('does not revive a stale legacy disk location when current settings omit it', async () => {
    const probes = io()
    probes.readText = async path => path.endsWith('settings-store.json') ? '{}' : JSON.stringify({ dataFolder: '/old/docker' })
    const snapshot = await readResources({ installPath: '/repo', platform: 'darwin', home: '/Users/test', host: { ...host, platform: 'darwin', arch: 'arm64' }, env: {}, io: probes })
    expect(snapshot.dockerHostDisk).toBeNull()
  })
  it('bounds Docker CLI failure and returns explicit unavailable status', async () => {
    const probes = io()
    probes.capture = async () => new Promise(() => {})
    const snapshot = await readResources({ installPath: '/repo', platform: 'linux', home: '/home/test', env: {}, host, io: probes, timeoutMs: 100 })
    expect(snapshot.docker).toMatchObject({ status: 'unavailable', totalMemoryBytes: null, reason: expect.stringContaining('in time') })
  })
  it('does not attribute local Desktop storage to a remote Docker daemon', async () => {
    const probes = io()
    probes.readText = async () => JSON.stringify({ dataFolder: '/local/docker' })
    const snapshot = await readResources({ installPath: '/repo', platform: 'darwin', home: '/Users/test', env: { DOCKER_HOST: 'ssh://remote.example' }, host, io: probes })
    expect(snapshot.docker).toMatchObject({ status: 'unavailable', context: 'remote', reason: expect.stringContaining('remote endpoint') })
    expect(snapshot.dockerHostDisk).toBeNull()
  })
})

describe('Windows physical memory parser', () => {
  it('sums decimal module capacities without floating-point rounding', () => {
    expect(parseWindowsPhysicalMemoryBytes({ code: 0, stdout: '["8589934592","8589934592"]' })).toBe(16 * GiB)
  })
  it.each(['[]', 'null', '8589934592', '[8589934592]', '["0"]', '["-1"]', '["8e9"]', '["8589934592",null]', '["9007199254740992"]'])('rejects unusable capacity output %s', stdout => {
    expect(parseWindowsPhysicalMemoryBytes({ code: 0, stdout })).toBeNull()
  })
})

describe('Docker resource parsers', () => {
  it.each([['npipe:////./pipe/dockerDesktopLinuxEngine', 'local'], ['unix:///var/run/docker.sock', 'local'], ['tcp://127.0.0.1:2375', 'local'], ['ssh://remote.example', 'remote'], ['tcp://daemon.example:2376', 'remote'], ['', 'unknown']])('classifies Docker endpoint %s without exposing it', (endpoint, expected) => {
    expect(dockerEndpointLocation(endpoint)).toBe(expected)
  })
  it('reports unknown storage for normal Desktop info instead of using a virtual size or host path', () => {
    expect(parseDockerResources(docker({ DriverStatus: [['Backing Filesystem', 'extfs']] }))).toMatchObject({ status: 'ok', storageFreeBytes: null, storageReason: expect.any(String) })
  })
  it('accepts actual free storage metrics and rejects malformed/Windows engine responses', () => {
    expect(parseDockerResources(docker({ DriverStatus: [['Data Space Available', '30 GiB']] })).storageFreeBytes).toBe(30 * GiB)
    expect(parseDockerResources(docker({ OSType: 'windows' })).status).toBe('unsupported')
    expect(parseDockerResources({ code: 0, stdout: 'not json' }).status).toBe('unavailable')
    expect(parseDockerResources(docker({ MemTotal: -1 })).totalMemoryBytes).toBeNull()
  })
  it.each([['25 GB', 25e9], ['0 B', 0], ['1.5 GiB', 1.5 * GiB], ['unknown', null], ['12%', null]])('parses an explicit byte quantity %s', (input, expected) => {
    expect(parseDockerStorageBytes(input)).toBe(expected)
  })
  it('accepts native Mac, Windows and managed setting paths but rejects malformed/relative values', () => {
    expect(dockerDataPathFromSettings('{"diskImageLocation":"~/Library/Docker Space"}', 'darwin', '/Users/test')).toBe('/Users/test/Library/Docker Space')
    expect(dockerDataPathFromSettings('{"dataFolder":{"value":"D:/Docker"}}', 'win32', 'C:/Users/test')).toBe('D:\\Docker')
    expect(dockerDataPathFromSettings('{"dataFolder":"relative/path"}', 'darwin', '/Users/test')).toBeNull()
    expect(dockerDataPathFromSettings('bad json', 'darwin', '/Users/test')).toBeNull()
  })
})
