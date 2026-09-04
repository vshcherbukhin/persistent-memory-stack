import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdateRunner, runtimeServices, updateNotificationSettingsBackup } from '../src/update.ts'

describe('update-runner Node compatibility', () => {
  it('keeps the Node strip-types dependency graph free of constructor parameter properties', async () => {
    const source = await readFile(new URL('../../../layers/update-ops/update-flow/update.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/constructor\(\s*\n?\s*(?:public |private |protected |readonly )/u)
  })
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_AUTHOR_NAME: 'Persistent Memory Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Persistent Memory Test',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
}

describe('update status checks', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stays quiet when remote metadata cannot be fetched', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    git(repoDir, ['init', '-b', 'master'])
    git(repoDir, ['add', 'package.json'])
    git(repoDir, ['commit', '-m', 'init'])
    git(repoDir, ['remote', 'add', 'origin', 'file:///definitely/missing/persistent-memory.git'])

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.status()).resolves.toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: null,
      updateAvailable: false,
      autoUpdateReady: false,
      logs: [],
    })
  })

  it('detects newer releases through configured Bitbucket Server metadata without enabling auto-update', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    await writeFile(join(repoDir, '.env.persistent-memory'), [
      'UPDATE_CHECK_PROVIDER=bitbucket',
      'UPDATE_BITBUCKET_URL=https://stash.example.test',
      'UPDATE_BITBUCKET_TOKEN=bb-token',
      'UPDATE_BITBUCKET_PROJECT=PM',
      'UPDATE_BITBUCKET_REPO=persistent-memory',
      'UPDATE_BITBUCKET_BRANCH=master',
      '',
    ].join('\n'))
    git(repoDir, ['init', '-b', 'master'])
    git(repoDir, ['add', 'package.json'])
    git(repoDir, ['commit', '-m', 'init'])

    const releaseHistory = [
      '# Release History',
      '',
      '## 1.1.0 - 2026-07-04',
      '',
      '| Service | Version | Change |',
      '| --- | --- | --- |',
      '| update-runner | 0.2.0 | Added Bitbucket checks. |',
      '',
      '- New update detection.',
      '',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://dashboard:3000/release-history.md') return new Response('not found', { status: 404 })
      expect(init?.headers).toMatchObject({ authorization: 'Bearer bb-token' })
      if (url.includes('/commits')) return new Response(JSON.stringify({ values: [{ id: 'remote-sha' }] }), { status: 200 })
      if (url.includes('/raw/package.json')) return new Response(JSON.stringify({ version: '1.1.0' }), { status: 200 })
      if (url.includes('/raw/release-history.md')) return new Response(releaseHistory, { status: 200 })
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.status()).resolves.toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateBranch: 'master',
      latestCommit: 'remote-sha',
      updateAvailable: true,
      autoUpdateReady: false,
      releaseNotes: { version: '1.1.0', latest: true },
    })
  })

  it('shows dev branch updates when the commit changed without a version bump', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    await writeFile(join(repoDir, '.env.persistent-memory'), [
      'UPDATE_CHECK_PROVIDER=bitbucket',
      'UPDATE_BITBUCKET_URL=https://stash.example.test',
      'UPDATE_BITBUCKET_TOKEN=bb-token',
      'UPDATE_BITBUCKET_SCOPE=user',
      'UPDATE_BITBUCKET_USER=example.user',
      'UPDATE_BITBUCKET_REPO=persistent-memory',
      'UPDATE_BITBUCKET_BRANCH=dev',
      '',
    ].join('\n'))
    git(repoDir, ['init', '-b', 'dev'])
    git(repoDir, ['add', 'package.json'])
    git(repoDir, ['commit', '-m', 'init'])

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://dashboard:3000/release-history.md') return new Response('not found', { status: 404 })
      if (url.includes('/commits')) return new Response(JSON.stringify({ values: [{ id: 'dev-remote-sha' }] }), { status: 200 })
      if (url.includes('/raw/package.json')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
      if (url.includes('/raw/release-history.md')) return new Response('# Release History\n\n## 1.0.0 - 2026-07-04\n\n- Same version dev update.\n', { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch)

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.status()).resolves.toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateBranch: 'dev',
      latestCommit: 'dev-remote-sha',
      updateAvailable: true,
      autoUpdateReady: false,
    })
  })

  it('hides dev branch updates after the deployed marker reaches the remote commit', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    await writeFile(join(repoDir, '.env.persistent-memory'), [
      'UPDATE_CHECK_PROVIDER=bitbucket',
      'UPDATE_BITBUCKET_URL=https://stash.example.test',
      'UPDATE_BITBUCKET_TOKEN=bb-token',
      'UPDATE_BITBUCKET_SCOPE=user',
      'UPDATE_BITBUCKET_USER=example.user',
      'UPDATE_BITBUCKET_REPO=persistent-memory',
      'UPDATE_BITBUCKET_BRANCH=dev',
      '',
    ].join('\n'))
    await mkdir(join(repoDir, '.local', 'update-state'), { recursive: true })
    await writeFile(join(repoDir, '.local', 'update-state', 'last-successful-update.json'), `${JSON.stringify({
      id: '2026-07-06T21:50:00Z-1.0.0',
      source: 'update-script',
      version: '1.0.0',
      finishedAt: '2026-07-06T21:50:00Z',
      branch: 'dev',
      commit: 'dev-remote-sha',
    })}\n`)
    git(repoDir, ['init', '-b', 'dev'])
    git(repoDir, ['add', 'package.json'])
    git(repoDir, ['commit', '-m', 'init'])

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://dashboard:3000/release-history.md') return new Response('not found', { status: 404 })
      if (url.includes('/commits')) return new Response(JSON.stringify({ values: [{ id: 'dev-remote-sha' }] }), { status: 200 })
      if (url.includes('/raw/package.json')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
      if (url.includes('/raw/release-history.md')) return new Response('# Release History\n\n## 1.0.0 - 2026-07-04\n\n- Same version dev update.\n', { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch)

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.status()).resolves.toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateBranch: 'dev',
      latestCommit: 'dev-remote-sha',
      updateAvailable: false,
    })
  })

  it('compares remote releases against the deployed dashboard version, not only the bind-mounted repo version', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '3.7.0' })}\n`)
    await writeFile(join(repoDir, '.env.persistent-memory'), [
      'UPDATE_CHECK_PROVIDER=bitbucket',
      'UPDATE_BITBUCKET_URL=https://stash.example.test',
      'UPDATE_BITBUCKET_TOKEN=bb-token',
      'UPDATE_BITBUCKET_SCOPE=user',
      'UPDATE_BITBUCKET_USER=example.user',
      'UPDATE_BITBUCKET_REPO=persistent-memory',
      'UPDATE_BITBUCKET_BRANCH=master',
      '',
    ].join('\n'))
    git(repoDir, ['init', '-b', 'master'])
    git(repoDir, ['add', 'package.json'])
    git(repoDir, ['commit', '-m', 'init'])

    const deployedHistory = '# Release History\n\n## 3.6.9 - 2026-07-04\n\n- Deployed dashboard release.\n'
    const remoteHistory = '# Release History\n\n## 3.7.0 - 2026-07-04\n\n- Remote release.\n'
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://dashboard:3000/release-history.md') return new Response(deployedHistory, { status: 200 })
      expect(init?.headers).toMatchObject({ authorization: 'Bearer bb-token' })
      if (url.includes('/commits')) return new Response(JSON.stringify({ values: [{ id: 'remote-sha' }] }), { status: 200 })
      if (url.includes('/raw/package.json')) return new Response(JSON.stringify({ version: '3.7.0' }), { status: 200 })
      if (url.includes('/raw/release-history.md')) return new Response(remoteHistory, { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch)

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.status()).resolves.toMatchObject({
      currentVersion: '3.6.9',
      latestVersion: '3.7.0',
      updateAvailable: true,
    })
  })

  it('reports the terminal updater success marker so open dashboard tabs can reload promptly', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '3.7.4' })}\n`)
    await mkdir(join(repoDir, '.local', 'update-state'), { recursive: true })
    await writeFile(join(repoDir, '.local', 'update-state', 'last-successful-update.json'), `${JSON.stringify({
      id: '2026-07-04T01:02:03Z-3.7.5',
      source: 'update-script',
      version: '3.7.5',
      finishedAt: '2026-07-04T01:02:03Z',
    })}\n`)
    git(repoDir, ['init', '-b', 'master'])
    git(repoDir, ['add', 'package.json'])
    git(repoDir, ['commit', '-m', 'init'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch)

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.status()).resolves.toMatchObject({
      lastSuccessfulUpdate: {
        id: '2026-07-04T01:02:03Z-3.7.5',
        source: 'update-script',
        version: '3.7.5',
        finishedAt: '2026-07-04T01:02:03Z',
      },
    })
  })

  it('supports Bitbucket personal repositories under users/{slug}/repos/{repo}', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    await writeFile(join(repoDir, '.env.persistent-memory'), [
      'UPDATE_CHECK_PROVIDER=bitbucket',
      'UPDATE_BITBUCKET_URL=https://stash.example.test',
      'UPDATE_BITBUCKET_TOKEN=bb-token',
      'UPDATE_BITBUCKET_SCOPE=user',
      'UPDATE_BITBUCKET_USER=example.user',
      'UPDATE_BITBUCKET_REPO=persistent-memory',
      'UPDATE_BITBUCKET_BRANCH=master',
      '',
    ].join('\n'))
    git(repoDir, ['init', '-b', 'master'])
    git(repoDir, ['add', 'package.json'])
    git(repoDir, ['commit', '-m', 'init'])

    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url === 'http://dashboard:3000/release-history.md') return new Response('not found', { status: 404 })
      if (url.includes('/commits')) return new Response(JSON.stringify({ values: [{ id: 'personal-sha' }] }), { status: 200 })
      if (url.includes('/raw/package.json')) return new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })
      if (url.includes('/raw/release-history.md')) return new Response('# Release History\n\n## 1.2.0 - 2026-07-04\n\n- Personal repo update.\n', { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch)

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.status()).resolves.toMatchObject({
      latestVersion: '1.2.0',
      latestCommit: 'personal-sha',
      updateAvailable: true,
    })
    const bitbucketUrls = urls.filter((url) => url.includes('/rest/api/1.0/'))
    expect(bitbucketUrls.every((url) => url.includes('/rest/api/1.0/users/example.user/repos/persistent-memory/'))).toBe(true)
  })
})

describe('snapshot-safe update service selection', () => {
  it('rebuilds the canonical dashboard, gateway, and documentation services', () => {
    expect(runtimeServices({ PM_MCP_RUNTIME: 'node' })).toEqual([
      'api',
      'dashboard',
      'documentation',
      'dashboard-gateway',
      'worker',
      'docker-control',
      'graphiti',
      'dlp',
    ])
    expect(runtimeServices({ PM_MCP_RUNTIME: 'stream' })).toContain('mcp')
    expect(runtimeServices({ PM_MCP_RUNTIME: 'stream' })).not.toContain('admin')
  })
})

describe('update notification settings', () => {
  it('builds a redacted backup shape for update notification settings', () => {
    expect(updateNotificationSettingsBackup({
      UPDATE_CHECK_PROVIDER: 'bitbucket',
      UPDATE_BITBUCKET_URL: 'https://stash.example.test',
      UPDATE_BITBUCKET_TOKEN: 'secret-token',
      UPDATE_BITBUCKET_SCOPE: 'user',
      UPDATE_BITBUCKET_USER: 'example.user',
      UPDATE_BITBUCKET_REPO: 'persistent-memory',
      UPDATE_BITBUCKET_BRANCH: 'master',
    }, 'fallback')).toEqual({
      enabled: true,
      provider: 'bitbucket',
      bitbucket: {
        url: 'https://stash.example.test',
        tokenConfigured: true,
        scope: 'user',
        project: '',
        user: 'example.user',
        repo: 'persistent-memory',
        branch: 'master',
      },
      note: 'Bitbucket token is redacted here; the raw value is preserved in the .env.persistent-memory snapshot.',
    })
  })

  it('reads redacted Bitbucket settings from the runtime env file', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    await writeFile(join(repoDir, '.env.persistent-memory'), [
      'UPDATE_CHECK_PROVIDER=bitbucket',
      'UPDATE_BITBUCKET_URL=https://stash.example.test',
      'UPDATE_BITBUCKET_TOKEN=bb-token',
      'UPDATE_BITBUCKET_SCOPE=user',
      'UPDATE_BITBUCKET_USER=example.user',
      'UPDATE_BITBUCKET_REPO=persistent-memory',
      'UPDATE_BITBUCKET_BRANCH=master',
      '',
    ].join('\n'))

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await expect(runner.settings()).resolves.toEqual({
      enabled: true,
      provider: 'bitbucket',
      bitbucket: {
        url: 'https://stash.example.test',
        tokenConfigured: true,
        scope: 'user',
        project: '',
        user: 'example.user',
        repo: 'persistent-memory',
        branch: 'master',
      },
    })
  })

  it('saves Bitbucket settings and preserves the token when no replacement is provided', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    await writeFile(join(repoDir, '.env.persistent-memory'), [
      'DATABASE_URL=postgresql://example',
      'UPDATE_CHECK_PROVIDER=bitbucket',
      'UPDATE_BITBUCKET_URL=https://stash.example.test',
      'UPDATE_BITBUCKET_TOKEN=old-token',
      'UPDATE_BITBUCKET_SCOPE=user',
      'UPDATE_BITBUCKET_USER=example.user',
      'UPDATE_BITBUCKET_REPO=persistent-memory',
      'UPDATE_BITBUCKET_BRANCH=master',
      '',
    ].join('\n'))

    const runner = createUpdateRunner({
      repoDir,
      backupRoot: join(repoDir, '.local', 'update-backups'),
      branch: 'master',
    })

    await runner.saveSettings({
      enabled: true,
      provider: 'bitbucket',
      bitbucket: {
        url: 'https://stash.example.test',
        token: '',
        scope: 'project',
        project: 'ENG',
        user: '',
        repo: 'example-service',
        branch: 'release',
      },
    })

    const env = await readFile(join(repoDir, '.env.persistent-memory'), 'utf8')
    expect(env).toContain('DATABASE_URL=postgresql://example')
    expect(env).toContain('UPDATE_CHECK_PROVIDER=bitbucket')
    expect(env).toContain('UPDATE_BITBUCKET_URL=https://stash.example.test')
    expect(env).toContain('UPDATE_BITBUCKET_TOKEN=old-token')
    expect(env).toContain('UPDATE_BITBUCKET_SCOPE=project')
    expect(env).toContain('UPDATE_BITBUCKET_PROJECT=ENG')
    expect(env).toContain('UPDATE_BITBUCKET_USER=')
    expect(env).toContain('UPDATE_BITBUCKET_REPO=example-service')
    expect(env).toContain('UPDATE_BITBUCKET_BRANCH=release')
  })

  it('tests proposed Bitbucket settings without persisting them', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'pm-update-runner-'))
    await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({ version: '1.0.0' })}\n`)
    const envPath = join(repoDir, '.env.persistent-memory')
    const originalEnv = ['UPDATE_CHECK_PROVIDER=none', 'UPDATE_BITBUCKET_TOKEN=old-token', ''].join('\n')
    await writeFile(envPath, originalEnv)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/commits')) return new Response(JSON.stringify({ values: [{ id: 'verified-sha' }] }), { status: 200 })
      if (url.includes('/raw/package.json')) return new Response(JSON.stringify({ version: '1.0.1' }), { status: 200 })
      return new Response('# Release History\n\n## 1.0.1 - 2026-07-13\n', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const runner = createUpdateRunner({ repoDir, backupRoot: join(repoDir, '.local', 'update-backups'), branch: 'master' })

    await expect(runner.testSettings({
      enabled: true,
      provider: 'bitbucket',
      bitbucket: {
        url: 'https://stash.example.test',
        token: 'new-token',
        scope: 'user',
        user: 'example.user',
        repo: 'persistent-memory',
        branch: 'master',
      },
    })).resolves.toEqual({
      ok: true,
      provider: 'bitbucket',
      repository: 'example.user/persistent-memory',
      branch: 'master',
      latestCommit: 'verified-sha',
      latestVersion: '1.0.1',
    })

    await expect(readFile(envPath, 'utf8')).resolves.toBe(originalEnv)
  })
})
