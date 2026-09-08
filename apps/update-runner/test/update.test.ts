import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateRunner } from '../src/update.ts'
import { createPublicUpdateMetadataCache, fetchPublicUpdateMetadata, isPublicUpdateRepository, publicUpdateSource } from '../../../layers/update-ops/update-flow/github.ts'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const sha = 'a'.repeat(40)
const baseUrl = 'https://api.github.com/repos/vshcherbukhin/persistent-memory-stack/'
const history = (version: string) => `<!-- persistent-memory-release-line: public-v1 -->\n# Release History\n\n## ${version} - 2026-09-06\n\n- [mcp-restart] Updated memory tools.\n`
const published = (version = '1.1.0') => ({ tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-09-07T12:00:00Z', target_commitish: 'master', html_url: `https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v${version}` })
const metadataFetch = (version = '1.1.0') => vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/releases/')) return new Response(JSON.stringify(published(version)))
  if (url.includes('/git/ref/tags/')) return new Response(JSON.stringify({ ref: `refs/tags/v${version}`, object: { type: 'commit', sha } }))
  if (url.includes('/contents/package.json')) return new Response(JSON.stringify({ version, persistentMemoryReleaseLine: publicUpdateSource.releaseLine }))
  if (url.includes('/contents/release-history.md')) return new Response(history(version))
  throw new Error('Unexpected fixture request')
})

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 }))))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.mocked(spawn).mockReset() })

describe('public release source', () => {
  it('uses the committed canonical manifest and supports Node strip-types execution', async () => {
    expect(publicUpdateSource).toEqual({ owner: 'vshcherbukhin', repo: 'persistent-memory-stack', branch: 'master', channel: 'releases', releaseLine: 'public-v1' })
    for (const file of ['update.ts', 'github.ts']) {
      const source = await readFile(new URL(`../../../layers/update-ops/update-flow/${file}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/constructor\(\s*\n?\s*(?:public |private |protected |readonly )/u)
    }
  })

  it('requests the latest published release anonymously and reads both files at its exact tag commit', async () => {
    vi.stubEnv('UPDATE_GITHUB_OWNER', 'untrusted-owner')
    vi.stubEnv('UPDATE_GITHUB_REPO', 'another-repo')
    vi.stubEnv('UPDATE_GITHUB_BRANCH', 'dev')
    vi.stubEnv('UPDATE_GITHUB_TOKEN', 'fixture-private-token')
    const fetchMock = metadataFetch()
    await expect(fetchPublicUpdateMetadata(fetchMock)).resolves.toEqual({ latestCommit: sha, latestVersion: '1.1.0', releaseHistory: history('1.1.0'), releaseTag: 'v1.1.0', releaseUrl: published().html_url })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}releases/latest`, `${baseUrl}git/ref/tags/v1.1.0`, `${baseUrl}contents/package.json?ref=${sha}`, `${baseUrl}contents/release-history.md?ref=${sha}`,
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

  it('keeps network and malformed release errors safe', async () => {
    await expect(fetchPublicUpdateMetadata(vi.fn(async () => { throw new Error('private network details') }))).rejects.not.toThrow('private network details')
    for (const body of ['not json', '{}', '{"commit":{"sha":"master"}}']) {
      const fetchMock = vi.fn(async () => new Response(body))
      await expect(fetchPublicUpdateMetadata(fetchMock)).rejects.toThrow('invalid release metadata')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it.each([undefined, 'private-v0'])('refuses old unmarked release metadata with release line %s before fetching history', async releaseLine => {
    const original = metadataFetch('4.0.37')
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/contents/package.json')
      ? new Response(JSON.stringify({ version: '4.0.37', persistentMemoryReleaseLine: releaseLine }))
      : original(input))
    await expect(fetchPublicUpdateMetadata(fetchMock)).rejects.toThrow('public release line is not available')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const cache = createPublicUpdateMetadataCache({ fetchImpl: fetchMock })
    await expect(cache.read()).resolves.toBeNull()
  })

  it.each(['{}', '{"version":"text"}', '{"version":"1.2.3-dev"}', '{"version":123}', '{"version":"01.2.3"}'])('rejects invalid versions before fetching history: %s', pkg => {
    const original = metadataFetch()
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/contents/package.json') ? new Response(pkg) : original(input))
    return expect(fetchPublicUpdateMetadata(fetchMock)).rejects.toThrow('invalid release metadata').then(() => expect(fetchMock).toHaveBeenCalledTimes(3))
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
    expect(fetchMock).toHaveBeenCalledTimes(4)
    now = 15 * 60_000 - 1
    await Promise.all(Array.from({ length: 100 }, () => cache.read()))
    expect(fetchMock).toHaveBeenCalledTimes(4)
    now++
    await cache.read()
    expect(fetchMock).toHaveBeenCalledTimes(8)
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
    const runner = createUpdateRunner({ repoDir, branch, backupRoot: join(repoDir, '.local', 'backups') }, {
      metadataCache,
    })
    return { runner, repoDir }
  }

  it('checks published releases without an environment file and preserves release notes and MCP restart detection', async () => {
    const { runner, repoDir } = await fixture('1.0.0', 'dev')
    await expect(runner.status()).resolves.toMatchObject({ currentVersion: '1.0.0', latestVersion: '1.1.0', releaseTag: 'v1.1.0', updateAvailable: true, autoUpdateReady: false, mcpRestartRequired: true, logs: [] })
    expect((await runner.status()).updateBranch).toBeUndefined()
    expect(existsSync(join(repoDir, '.env.persistent-memory'))).toBe(false)
  })

  it('uses semver for public release notices, independent of an operator branch', async () => {
    const { runner } = await fixture('1.1.0', 'dev')
    await expect(runner.status()).resolves.toMatchObject({ releaseTag: 'v1.1.0', updateAvailable: false })
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
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each(['master', 'dev'])('refuses legacy sidecar installs with %s config before any subprocess or data change', async branch => {
    const { runner, repoDir } = await fixture('1.0.0', branch)
    const env = 'DATABASE_MIGRATE_URL=postgresql://fixture-only\nPM_MCP_RUNTIME=stream\n'
    await writeFile(join(repoDir, '.env.persistent-memory'), env)
    await expect(runner.start()).resolves.toEqual({ ok: false })
    await expect(runner.logs()).resolves.toMatchObject({ running: false, lastRun: { ok: false, error: expect.stringContaining('coordinator') } })
    expect(spawn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(existsSync(join(repoDir, '.local', 'backups'))).toBe(false)
    expect(await readFile(join(repoDir, '.env.persistent-memory'), 'utf8')).toBe(env)
  })
})