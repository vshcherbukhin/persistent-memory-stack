import { describe, expect, it, vi } from 'vitest'
import { authOk, createServer, route, type UpdateRunnerOps } from '../src/server.ts'
import type { UpdateNotificationSettings } from '../src/update.ts'

const enabledSettings = {
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
} satisfies UpdateNotificationSettings

const disabledSettings = {
  enabled: false,
  provider: 'none',
  bitbucket: {
    url: 'https://stash.example.test',
    tokenConfigured: true,
    scope: 'user',
    project: '',
    user: 'example.user',
    repo: 'persistent-memory',
    branch: 'master',
  },
} satisfies UpdateNotificationSettings

const ops = (overrides: Partial<UpdateRunnerOps> = {}): UpdateRunnerOps => ({
  status: vi.fn(async () => ({ currentVersion: '3.4.6', latestVersion: '3.5.0', updateAvailable: true, running: false, logs: [] })),
  start: vi.fn(async () => ({ ok: true })),
  logs: vi.fn(async () => ({ running: false, logs: ['done'] })),
  settings: vi.fn(async () => enabledSettings),
  saveSettings: vi.fn(async () => disabledSettings),
  testSettings: vi.fn(async () => ({
    ok: true as const,
    provider: 'bitbucket' as const,
    repository: 'example.user/persistent-memory',
    branch: 'master',
    latestCommit: 'verified-sha',
    latestVersion: '4.0.28',
  })),
  ...overrides,
})

describe('update-runner auth and routes', () => {
  it('fails closed when the shared token is blank or wrong', () => {
    expect(authOk('Bearer secret', '')).toBe(false)
    expect(authOk('Bearer nope', 'secret')).toBe(false)
    expect(authOk('Bearer secret', 'secret')).toBe(true)
  })

  it('returns update status and starts exactly one bounded update action', async () => {
    const o = ops()
    await expect(route('GET', '/status', new URLSearchParams(), o)).resolves.toMatchObject({
      status: 200,
      body: { latestVersion: '3.5.0', updateAvailable: true },
    })
    await expect(route('POST', '/start', new URLSearchParams(), o)).resolves.toMatchObject({
      status: 202,
      body: { ok: true },
    })
    expect(o.start).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown verbs before any update operation can run', async () => {
    const o = ops()
    await expect(route('DELETE', '/start', new URLSearchParams(), o)).resolves.toMatchObject({
      status: 405,
      body: { error: 'method_not_allowed' },
    })
    await expect(route('POST', '/shell', new URLSearchParams(), o)).resolves.toMatchObject({
      status: 404,
      body: { error: 'not_found' },
    })
    expect(o.start).not.toHaveBeenCalled()
  })

  it('reads and saves update notification settings without starting an update', async () => {
    const o = ops()
    await expect(route('GET', '/settings', new URLSearchParams(), o)).resolves.toMatchObject({
      status: 200,
      body: { enabled: true, provider: 'bitbucket' },
    })
    await expect(route('PATCH', '/settings', new URLSearchParams(), o, {
      enabled: false,
      provider: 'none',
    })).resolves.toMatchObject({
      status: 200,
      body: { enabled: false, provider: 'none' },
    })
    expect(o.settings).toHaveBeenCalledTimes(1)
    expect(o.saveSettings).toHaveBeenCalledWith({ enabled: false, provider: 'none' })
    expect(o.start).not.toHaveBeenCalled()
  })

  it('tests a proposed update source without saving settings', async () => {
    const testSettings = vi.fn(async () => ({
      ok: true,
      provider: 'bitbucket' as const,
      repository: 'example.user/persistent-memory',
      branch: 'master',
      latestCommit: 'verified-sha',
      latestVersion: '4.0.28',
    }))
    const o = { ...ops(), testSettings } as unknown as UpdateRunnerOps

    await expect(route('POST', '/test', new URLSearchParams(), o, {
      enabled: true,
      provider: 'bitbucket',
    })).resolves.toMatchObject({
      status: 200,
      body: { ok: true, latestCommit: 'verified-sha' },
    })
    expect(testSettings).toHaveBeenCalledWith({ enabled: true, provider: 'bitbucket' })
  })

  it('logs a safe request identifier when an updater request fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = createServer({
      token: 'secret',
      ops: ops({ saveSettings: vi.fn(async () => { throw new Error('runtime environment is not writable') }) }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not listen')
      const response = await fetch(`http://127.0.0.1:${address.port}/settings`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      await expect(response.json()).resolves.toMatchObject({ error: 'internal', requestId: expect.any(String) })
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('PATCH /settings'))
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
      errorSpy.mockRestore()
    }
  })
})
