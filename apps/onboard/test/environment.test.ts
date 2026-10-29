import { resolve, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BUILD_NETWORK_ENDPOINTS, checkEnvironmentPorts, environmentPorts, readEnvironment, type EnvironmentIO } from '../server/environment.ts'
import { environmentIssues } from '../shared/environment.ts'
import { buildPrereqInstallPlan, node24FromWingetVersions, parseComposeVersion } from '../server/prereq.ts'

const root = resolve('synthetic-environment')
function ioFixture() {
  const capture = vi.fn(async (command: string, args: string[]) => {
    const text = [command, ...args].join(' ')
    if (command === 'npm') return { code: 0, stdout: '11.12.1' }
    if (command === 'git') return { code: 0, stdout: 'git version 2.51.1.windows.1' }
    if (command === 'bash') return { code: 0, stdout: '5.2.37(1)-release\nMINGW64_NT\n/usr/bin/curl\n' }
    if (text === 'docker --version') return { code: 0, stdout: 'Docker version 29.0.1, build synthetic' }
    if (args[0] === 'info') return { code: 0, stdout: 'linux' }
    if (args[0] === 'context') return { code: 0, stdout: '"npipe:////./pipe/dockerDesktopLinuxEngine"' }
    if (text === 'docker compose version') return { code: 0, stdout: 'Docker Compose version v2.24.4' }
    if (text === 'docker buildx version') return { code: 0, stdout: 'github.com/docker/buildx v0.30.0' }
    if (text === 'docker ps -q') return { code: 0, stdout: '' }
    if (args.includes('config') && args.includes('--quiet')) return { code: 0, stdout: '' }
    throw new Error(`Unexpected synthetic command ${text}`)
  })
  return { capture, writable: vi.fn(async (_path: string) => true), canBind: vi.fn(async (_host: string, _port: number) => true), reachable: vi.fn(async (_url: string) => true) } satisfies EnvironmentIO
}

describe('fresh wizard environment checks', () => {
  it('rejects a remote Docker override even when its Linux engine is running', async () => {
    const result = await readEnvironment({ root, env: { DOCKER_HOST: 'ssh://remote.example.test' }, platform: 'win32', nodeVersion: 'v24.14.1', envFilePresent: true, io: ioFixture() })
    expect(result.ok).toBe(false)
    expect(result.checks.docker.detail).toContain('local Docker')
  })
  it('honours explicit Docker context precedence over a conflicting host override', async () => {
    for (const [endpoint, host, allowed] of [
      ['ssh://remote.example.test', 'npipe:////./pipe/dockerDesktopLinuxEngine', false],
      ['npipe:////./pipe/dockerDesktopLinuxEngine', 'ssh://remote.example.test', true],
    ] as const) {
      const io = ioFixture()
      const original = io.capture.getMockImplementation()!
      io.capture.mockImplementation(async (command, args) => args[0] === 'context' ? { code: 0, stdout: JSON.stringify(endpoint) } : original(command, args))
      const result = await readEnvironment({ root, env: { DOCKER_CONTEXT: 'selected-context', DOCKER_HOST: host }, platform: 'win32', nodeVersion: 'v24.14.1', envFilePresent: true, io })
      expect(result.checks.docker.ok, endpoint).toBe(allowed)
      expect(result.ok, endpoint).toBe(allowed)
    }
  })
  it('does not mistake a named pipe on another Windows machine for a local engine', async () => {
    const io = ioFixture()
    const original = io.capture.getMockImplementation()!
    io.capture.mockImplementation(async (command, args) => args[0] === 'context' ? { code: 0, stdout: '"npipe:////another-machine/pipe/docker_engine"' } : original(command, args))
    const result = await readEnvironment({ root, env: { DOCKER_CONTEXT: 'remote-windows' }, platform: 'win32', nodeVersion: 'v24.14.1', envFilePresent: true, io })
    expect(result.checks.docker.ok).toBe(false)
  })
  it('checks all required host prerequisites without install/start/model commands and validates saved Compose', async () => {
    const io = ioFixture()
    const result = await readEnvironment({ root, env: {}, platform: 'win32', nodeVersion: 'v24.14.1', envFilePresent: true, io })
    expect(result.ok).toBe(true)
    expect(environmentIssues(result)).toEqual([])
    expect(io.capture).toHaveBeenCalledWith('docker', ['compose', '-f', join(root, 'deploy/compose/docker-compose.yml'), '--env-file', join(root, '.env.persistent-memory'), 'config', '--quiet'])
    expect(io.reachable.mock.calls.map(([url]) => url)).toEqual(BUILD_NETWORK_ENDPOINTS)
    for (const [command, args] of io.capture.mock.calls) {
      expect([command, ...args]).not.toContain('install')
      expect(args).not.toContain('pull')
      expect(args).not.toContain('up')
    }
  })
  it('enforces the exact Node lines and npm10/11 rather than trusting the browser or PATH runtime', async () => {
    for (const node of ['v22.11.0', 'v23.0.0', 'v25.0.0', 'v26.8.1', 'v24.0.0-rc.1']) {
      const result = await readEnvironment({ root, platform: 'win32', nodeVersion: node, envFilePresent: false, io: ioFixture() })
      expect(result.checks.node.ok, node).toBe(false)
    }
    for (const node of ['v22.12.0', 'v24.0.0']) expect((await readEnvironment({ root, platform: 'win32', nodeVersion: node, envFilePresent: false, io: ioFixture() })).checks.node.ok).toBe(true)
    const io = ioFixture()
    const original = io.capture.getMockImplementation()!
    io.capture.mockImplementation(async (command, args) => command === 'npm' ? { code: 0, stdout: '12.0.0' } : original(command, args))
    expect((await readEnvironment({ root, platform: 'win32', nodeVersion: 'v24.0.0', envFilePresent: false, io })).checks.npm.ok).toBe(false)
  })
  it('rejects old/prerelease Compose and accepts the tested floor and later stable/vendor releases', () => {
    for (const version of ['2.23.9', '2.24.0', '2.24.3', '2.24.4-rc.1', '1.29.2']) expect(parseComposeVersion(`Docker Compose version v${version}`, 0).ok, version).toBe(false)
    for (const version of ['2.24.4', '2.32.1-desktop.1', '5.0.1']) expect(parseComposeVersion(`Docker Compose version v${version}`, 0).ok, version).toBe(true)
  })
  it('fails closed on Windows containers, WSL Bash, Buildx/config failure, unwritable files or registry failure', async () => {
    for (const failure of ['docker', 'bash', 'curl', 'buildx', 'composeConfig', 'rootWrite', 'network'] as const) {
      const io = ioFixture()
      const original = io.capture.getMockImplementation()!
      io.capture.mockImplementation(async (command, args) => {
        if (failure === 'docker' && args[0] === 'info') return { code: 0, stdout: 'windows' }
        if (failure === 'bash' && command === 'bash') return { code: 0, stdout: '5.2.0\nLinux' }
        if (failure === 'curl' && command === 'bash') return { code: 0, stdout: '5.2.0\nMINGW64_NT\n' }
        if (failure === 'buildx' && args[0] === 'buildx' || failure === 'composeConfig' && args.includes('--quiet')) return { code: 1, stdout: '' }
        return original(command, args)
      })
      if (failure === 'rootWrite') io.writable.mockResolvedValue(false)
      if (failure === 'network') io.reachable.mockResolvedValue(false)
      const result = await readEnvironment({ root, platform: 'win32', nodeVersion: 'v24.0.0', envFilePresent: true, io })
      expect(result.checks[failure === 'curl' ? 'bash' : failure].ok, failure).toBe(false)
      expect(result.ok).toBe(false)
    }
  })
  it('bounds a stalled tool probe instead of holding the installation reservation indefinitely', async () => {
    vi.useFakeTimers()
    try {
      const io = ioFixture()
      const original = io.capture.getMockImplementation()!
      io.capture.mockImplementation((command, args) => command === 'npm' ? new Promise(() => {}) : original(command, args))
      const reading = readEnvironment({ root, platform: 'win32', nodeVersion: 'v24.0.0', envFilePresent: false, io })
      await vi.advanceTimersByTimeAsync(10_001)
      expect((await reading).checks.npm.ok).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('defers config validation only before a configuration exists and rejects stale snapshots', async () => {
    const result = await readEnvironment({ root, platform: 'win32', nodeVersion: 'v24.0.0', envFilePresent: false, io: ioFixture() })
    expect(result.checks.composeConfig.detail).toContain('immediately before installation')
    expect(environmentIssues({ ...result, capturedAt: new Date(Date.now() - 31_000).toISOString() })[0].check).toBe('freshness')
  })
})

describe('ownership-aware host ports', () => {
  it('coexists with unrelated unlabeled containers while refusing their occupied ports', async () => {
    const io = ioFixture()
    io.capture.mockImplementation(async (_command, args) => args[0] === 'ps' ? { code: 0, stdout: 'a'.repeat(12) } : { code: 0, stdout: JSON.stringify({ name: '/unrelated', labels: null, ports: null }) })
    expect((await checkEnvironmentPorts(root, {}, 'win32', io)).ok).toBe(true)
    io.canBind.mockImplementation(async (_host, port) => port !== 8090)
    expect((await checkEnvironmentPorts(root, {}, 'win32', io)).ok).toBe(false)
  })
  it('uses explicit configured ports and rejects invalid/duplicate assignments', () => {
    expect(environmentPorts({ PM_API_PORT: '18090' })).toContainEqual({ service: 'api', port: 18090 })
    expect(() => environmentPorts({ PM_API_PORT: '0' })).toThrow('PM_API_PORT')
    expect(() => environmentPorts({ PM_API_PORT: '8091' })).toThrow('same host port')
  })
  it('approves an occupied port only for matching service/name/project/config provenance', async () => {
    const id = 'a'.repeat(12)
    const container = { name: '/persistent-memory-api', labels: {
      'com.docker.compose.project': 'persistent-memory', 'com.docker.compose.service': 'api',
      'com.docker.compose.project.config_files': join(root, 'deploy/compose/docker-compose.yml'),
    }, ports: { '8090/tcp': [{ HostIp: '127.0.0.1', HostPort: '8090' }] } }
    const io = ioFixture()
    io.canBind.mockImplementation(async (_host, port) => port !== 8090)
    io.capture.mockImplementation(async (_command, args) => args[0] === 'ps' ? { code: 0, stdout: id } : { code: 0, stdout: JSON.stringify(container) })
    expect((await checkEnvironmentPorts(root, {}, 'win32', io)).ok).toBe(true)
    for (const key of ['com.docker.compose.project', 'com.docker.compose.service', 'com.docker.compose.project.config_files']) {
      const original = container.labels[key as keyof typeof container.labels]
      container.labels[key as keyof typeof container.labels] = 'foreign'
      expect((await checkEnvironmentPorts(root, {}, 'win32', io)).ok).toBe(false)
      container.labels[key as keyof typeof container.labels] = original
    }
  })
})

describe('allowlisted native repair plans', () => {
  it('selects stable24.x WinGet metadata and never installs the upstream LTS alias or an arbitrary id', () => {
    expect(node24FromWingetVersions('26.0.0\n24.9.0\n24.14.1\n24.14.2-rc.1\n23.9.0')).toBe('24.14.1')
    const host = { platform: 'win32', brewPath: null, hasDocker: false, hasOllama: false, wingetPath: 'winget.exe', node24Version: '24.14.1' }
    const node = buildPrereqInstallPlan('node', host)[0].cmd
    expect(node).toContain('OpenJS.NodeJS.LTS')
    expect(node).toContain('24.14.1')
    expect(node.indexOf('--version')).toBeGreaterThan(-1)
    expect(buildPrereqInstallPlan('git', host)[0].cmd).toContain('Git.Git')
    expect(buildPrereqInstallPlan('docker', host)[0].cmd).toContain('Docker.DockerDesktop')
    expect(() => buildPrereqInstallPlan('node', { ...host, node24Version: '26.0.0' })).toThrow('supported Node 24')
    expect(() => buildPrereqInstallPlan('unexpected' as 'node', host)).toThrow('Unknown prerequisite')
  })
})
