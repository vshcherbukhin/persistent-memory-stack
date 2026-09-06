import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateRunner, runtimeServices } from '../src/update.ts'
import { createPublicUpdateMetadataCache, fetchPublicUpdateMetadata, isPublicUpdateRepository, publicUpdateSource } from '../../../layers/update-ops/update-flow/github.ts'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const sha = 'a'.repeat(40)
const baseUrl = 'https://api.github.com/repos/vshcherbukhin/persistent-memory-stack/'
const history = (version: string) => `<!-- persistent-memory-release-line: public-v1 -->\n# Release History\n\n## ${version} - 2026-09-06\n\n- [mcp-restart] Updated memory tools.\n`
const metadataFetch = (version = '1.1.0') => vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/branches/')) return new Response(JSON.stringify({ commit: { sha } }))
  if (url.includes('/contents/package.json')) return new Response(JSON.stringify({ version, persistentMemoryReleaseLine: publicUpdateSource.releaseLine }))
  if (url.includes('/contents/release-history.md')) return new Response(history(version))
  throw new Error('Unexpected fixture request')
})

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 }))))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.mocked(spawn).mockReset() })

describe('public release source', () => {
  it('uses the committed canonical manifest and supports Node strip-types execution', async () => {
    expect(publicUpdateSource).toEqual({ owner: 'vshcherbukhin', repo: 'persistent-memory-stack', branch: 'master', releaseLine: 'public-v1' })
    for (const file of ['update.ts', 'github.ts']) {
      const source = await readFile(new URL(`../../../layers/update-ops/update-flow/${file}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/constructor\(\s*\n?\s*(?:public |private |protected |readonly )/u)
    }
  })

  it('always requests public master without authentication and reads both files at its immutable commit', async () => {
    vi.stubEnv('UPDATE_GITHUB_OWNER', 'untrusted-owner')
    vi.stubEnv('UPDATE_GITHUB_REPO', 'another-repo')
    vi.stubEnv('UPDATE_GITHUB_BRANCH', 'dev')
    vi.stubEnv('UPDATE_GITHUB_TOKEN', 'fixture-private-token')
    const fetchMock = metadataFetch()
    await expect(fetchPublicUpdateMetadata(fetchMock)).resolves.toEqual({ latestCommit: sha, latestVersion: '1.1.0', releaseHistory: history('1.1.0') })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}branches/master`, `${baseUrl}contents/package.json?ref=${sha}`, `${baseUrl}contents/release-history.md?ref=${sha}`,
    ])
    const signals = new Set(fetchMock.mock.calls.map(([, init]) => init?.signal))
    expect(signals.size).toBe(1)
    expect([...signals][0]).toBeInstanceOf(AbortSignal)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).not.toHaveProperty('authorization')
      expect(JSON.stringify(init)).not.toContain('fixture-private-token')
      expect(init?.redirect).toBe('error')
    }
  })

  it.each([301, 401, 403, 404, 429, 500])('refuses HTTP %s without exposing remote response contents', async status => {
    const fetchMock = vi.fn(async () => new Response('private fixture response', { status, headers: { location: 'https://other.example/private' } }))
    const result = fetchPublicUpdateMetadata(fetchMock)
    await expect(result).rejects.toThrow(`HTTP ${status}`)
    await expect(result).rejects.not.toThrow('private fixture response')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps network and malformed commit errors safe', async () => {
    await expect(fetchPublicUpdateMetadata(vi.fn(async () => { throw new Error('private network details') }))).rejects.not.toThrow('private network details')
    for (const body of ['not json', '{}', '{"commit":{"sha":"master"}}']) {
      const fetchMock = vi.fn(async () => new Response(body))
      await expect(fetchPublicUpdateMetadata(fetchMock)).rejects.toThrow('invalid release metadata')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it.each([undefined, 'private-v0'])('refuses old master4.x metadata with release line %s before fetching history', async releaseLine => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/branches/')
      ? new Response(JSON.stringify({ commit: { sha } }))
      : new Response(JSON.stringify({ version: '4.0.37', persistentMemoryReleaseLine: releaseLine })))
    await expect(fetchPublicUpdateMetadata(fetchMock)).rejects.toThrow('public release line is not available')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const cache = createPublicUpdateMetadataCache({ fetchImpl: fetchMock })
    await expect(cache.read()).resolves.toBeNull()
  })

  it.each(['{}', '{"version":"text"}', '{"version":"1.2.3-dev"}', '{"version":123}', '{"version":"01.2.3"}'])('rejects invalid versions before fetching history: %s', pkg => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/branches/') ? new Response(JSON.stringify({ commit: { sha } })) : new Response(pkg))
    return expect(fetchPublicUpdateMetadata(fetchMock)).rejects.toThrow('invalid release metadata').then(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it.each([
    'https://github.com/vshcherbukhin/persistent-memory-stack.git', 'https://GitHub.com/Vshcherbukhin/Persistent-Memory-Stack',
    'git@github.com:vshcherbukhin/persistent-memory-stack.git', 'ssh://git@github.com/vshcherbukhin/persistent-memory-stack.git',
  ])('recognizes the canonical repository identity: %s', remote => expect(isPublicUpdateRepository(remote)).toBe(true))

  it.each([
    'https://github.com/another-owner/persistent-memory-stack.git', 'https://github.com/vshcherbukhin/another-repo.git',
    'https://github.com.evil.example/vshcherbukhin/persistent-memory-stack.git', 'https://user@github.com/vshcherbukhin/persistent-memory-stack.git',
    'https://github.com/vshcherbukhin/other/../persistent-memory-stack.git', 'ssh://git@github.com:2222/vshcherbukhin/persistent-memory-stack.git',
  ])('refuses a different or ambiguous repository identity: %s', remote => expect(isPublicUpdateRepository(remote)).toBe(false))
})

describe('anonymous request budget', () => {
  it('coalesces concurrent polling and reuses metadata for fifteen minutes', async () => {
    let now = 0
    const fetchMock = metadataFetch()
    const cache = createPublicUpdateMetadataCache({ fetchImpl: fetchMock, now: () => now })
    const pending = Array.from({ length: 40 }, () => cache.read())
    expect(new Set(pending).size).toBe(1)
    await Promise.all(pending)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    now = 15 * 60_000 - 1
    await Promise.all(Array.from({ length: 100 }, () => cache.read()))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    now++
    await cache.read()
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('backs off repeated failures for one, two, four, eight, then fifteen minutes', async () => {
    let now = 0
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }))
    const cache = createPublicUpdateMetadataCache({ fetchImpl: fetchMock, now: () => now })
    for (const [index, delay] of [1, 2, 4, 8, 15, 15].entries()) {
      await expect(cache.read()).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(index + 1)
      now += delay * 60_000 - 1
      await cache.read()
      expect(fetchMock).toHaveBeenCalledTimes(index + 1)
      now++
    }
  })

  it.each([
    { 'retry-after': '1800' },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800' },
    { 'retry-after': 'Thu, 01 Jan 1970 00:30:00 GMT' },
  ])('honors server rate-limit deadlines beyond the ordinary backoff: %j', headers => {
    let now = 0
    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(headers)) if (value !== undefined) responseHeaders.set(name, value)
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: responseHeaders }))
    const cache = createPublicUpdateMetadataCache({ fetchImpl: fetchMock, now: () => now })
    return cache.read().then(async () => {
      now = 30 * 60_000 - 1
      await cache.read()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      now++
      await cache.read()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  it('retains the last valid release during failures and resets the failure delay after recovery', async () => {
    let now = 0
    const fetchMock = metadataFetch()
    const cache = createPublicUpdateMetadataCache({ fetchImpl: fetchMock, now: () => now })
    const previous = await cache.read()
    now = 15 * 60_000
    fetchMock.mockImplementation(async () => new Response('', { status: 503 }))
    await expect(cache.read()).resolves.toEqual(previous)
    now += 60_000
    fetchMock.mockImplementation(metadataFetch('1.2.0'))
    await expect(cache.read()).resolves.toMatchObject({ latestVersion: '1.2.0' })
    now += 15 * 60_000
    fetchMock.mockImplementation(async () => new Response('', { status: 503 }))
    await cache.read()
    const calls = fetchMock.mock.calls.length
    now += 60_000
    await cache.read()
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1)
  })
})

describe('runner status and explicit update boundary', () => {
  async function fixture(version = '1.0.0', branch = 'master') {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-public-update-'))
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ version }))
    const metadataCache = createPublicUpdateMetadataCache({ fetchImpl: metadataFetch() })
    const runner = createUpdateRunner({ repoDir, branch, backupRoot: join(repoDir, '.local', 'backups') }, { metadataCache })
    return { runner, repoDir }
  }

  it('checks public master without an environment file and preserves release notes and MCP restart detection', async () => {
    const { runner, repoDir } = await fixture('1.0.0', 'dev')
    await expect(runner.status()).resolves.toMatchObject({ currentVersion: '1.0.0', latestVersion: '1.1.0', updateBranch: 'master', updateAvailable: true, autoUpdateReady: false, mcpRestartRequired: true, logs: [] })
    expect(existsSync(join(repoDir, '.env.persistent-memory'))).toBe(false)
  })

  it('uses semver for public release notices, independent of an operator branch', async () => {
    const { runner } = await fixture('1.1.0', 'dev')
    await expect(runner.status()).resolves.toMatchObject({ updateBranch: 'master', updateAvailable: false })
  })

  it('compares against the deployed dashboard and retains the post-update success signal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(history('1.0.0'))))
    const { runner, repoDir } = await fixture('1.1.0')
    await mkdir(join(repoDir, '.local', 'update-state'), { recursive: true })
    const signal = { id: 'fixture-success', source: 'update-script', releaseLine: 'public-v1', version: '1.0.0', finishedAt: '2026-09-06T10:00:00Z', branch: 'dev', commit: sha }
    await writeFile(join(repoDir, '.local', 'update-state', 'last-successful-update.json'), JSON.stringify(signal))
    await expect(runner.status()).resolves.toMatchObject({ currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, lastSuccessfulUpdate: signal })
  })

  it('ignores old unmarked deployed history and success markers after the public reset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Release History\n\n## 4.0.37 - 2026-09-01\n')))
    const { runner, repoDir } = await fixture('1.0.0')
    await mkdir(join(repoDir, '.local', 'update-state'), { recursive: true })
    const path = join(repoDir, '.local', 'update-state', 'last-successful-update.json')
    const oldMarker = JSON.stringify({ id: 'old-success', source: 'update-script', version: '4.0.37', finishedAt: '2026-09-01T10:00:00Z' })
    await writeFile(path, oldMarker)
    await expect(runner.status()).resolves.toMatchObject({ releaseLine: 'public-v1', currentVersion: '1.0.0', lastSuccessfulUpdate: undefined })
    await expect(readFile(path, 'utf8')).resolves.toBe(oldMarker)
  })

  it('shares one default metadata cache across runner instances', async () => {
    const fetchMock = metadataFetch()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => String(input).startsWith(baseUrl) ? fetchMock(input, init) : new Response('', { status: 404 })))
    const { repoDir } = await fixture()
    const cfg = { repoDir, branch: 'master', backupRoot: join(repoDir, '.local', 'backups') }
    await Promise.all([createUpdateRunner(cfg).status(), createUpdateRunner(cfg).status()])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('refuses a different checkout origin before any snapshot, fetch, merge, or service change', async () => {
    const commands: string[][] = []
    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[]) => {
      commands.push([command, ...args])
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => { child.stdout.end('https://github.com/other-owner/other-repo.git\n'); child.emit('close', 0) })
      return child
    }) as unknown as typeof spawn)
    const { runner, repoDir } = await fixture()
    await runner.start()
    await vi.waitFor(async () => expect(await runner.logs()).toMatchObject({ running: false, lastRun: { ok: false, error: expect.stringContaining('does not match') } }))
    expect(commands).toEqual([['git', '-c', `safe.directory=${repoDir}`, 'remote', 'get-url', 'origin']])
    expect(existsSync(join(repoDir, '.local', 'backups'))).toBe(false)
  })

  it('keeps an explicit operator dev update separate from public master checks', async () => {
    const commands: string[][] = []
    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[]) => {
      commands.push([command, ...args])
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        child.stdout.end(args.includes('get-url') ? 'git@github.com:vshcherbukhin/persistent-memory-stack.git\n'
          : args.includes('show') ? JSON.stringify({ persistentMemoryReleaseLine: 'public-v1' }) : '')
        child.emit('close', 0)
      })
      return child
    }) as unknown as typeof spawn)
    const { runner, repoDir } = await fixture('1.0.0', 'dev')
    await writeFile(join(repoDir, '.env.persistent-memory'), 'DATABASE_MIGRATE_URL=postgresql://fixture-only\nPM_MCP_RUNTIME=stream\n')
    await runner.start()
    await vi.waitFor(async () => expect(await runner.logs()).toMatchObject({ running: false, lastRun: { ok: true } }))
    expect(commands.find(command => command.includes('fetch'))?.slice(-4)).toEqual(['fetch', '--quiet', 'origin', 'dev'])
    expect(commands.find(command => command.includes('merge'))?.slice(-3)).toEqual(['merge', '--ff-only', 'origin/dev'])
    const { lastRun } = await runner.logs()
    expect(existsSync(join(lastRun!.backupPath!, 'manifest.json'))).toBe(true)
    expect(existsSync(join(lastRun!.backupPath!, 'update-notification-settings.json'))).toBe(false)
    const marker = JSON.parse(await readFile(join(repoDir, '.local', 'update-state', 'last-successful-update.json'), 'utf8'))
    expect(marker.branch).toBe('dev')
    expect(marker.releaseLine).toBe('public-v1')
    await expect(runner.status()).resolves.toMatchObject({ updateBranch: 'master' })
  })

  it('refuses an old unmarked branch target before merging or rebuilding services', async () => {
    const commands: string[][] = []
    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[]) => {
      commands.push([command, ...args])
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        child.stdout.end(args.includes('get-url') ? 'https://github.com/vshcherbukhin/persistent-memory-stack.git\n'
          : args.includes('show') ? JSON.stringify({ version: '4.0.37' }) : '')
        child.emit('close', 0)
      })
      return child
    }) as unknown as typeof spawn)
    const { runner, repoDir } = await fixture('1.0.0')
    await writeFile(join(repoDir, '.env.persistent-memory'), 'DATABASE_MIGRATE_URL=postgresql://fixture-only\n')
    await runner.start()
    await vi.waitFor(async () => expect(await runner.logs()).toMatchObject({ running: false, lastRun: { ok: false, error: expect.stringContaining('does not contain the public release line') } }))
    expect(commands.some(command => command.includes('merge'))).toBe(false)
    expect(commands.some(command => command[0] === 'docker' && command.includes('up'))).toBe(false)
  })

  it('keeps the canonical services for an explicitly requested snapshot-safe update', () => {
    expect(runtimeServices({ PM_MCP_RUNTIME: 'node' })).toEqual(['api', 'dashboard', 'documentation', 'dashboard-gateway', 'worker', 'docker-control', 'graphiti', 'dlp'])
    expect(runtimeServices({ PM_MCP_RUNTIME: 'stream' })).toContain('mcp')
  })
})
