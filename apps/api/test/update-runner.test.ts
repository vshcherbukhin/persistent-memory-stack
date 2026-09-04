import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.ts', () => ({
  config: {
    UPDATE_RUNNER_URL: 'http://update-runner:9092',
    UPDATE_RUNNER_TOKEN: 'update-secret',
  },
}))

import {
  UpdateRunnerUnavailableError,
  getUpdateLogs,
  getUpdateSettings,
  getUpdateStatus,
  saveUpdateSettings,
  startUpdate,
  testUpdateSettings,
} from '../src/services/update-runner.ts'

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('update-runner client', () => {
  it('forwards status/log/start calls with the update-runner bearer token', async () => {
    const settings = {
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
    }
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/settings')) return okJson(settings)
      if (init.method === 'POST') return okJson({ ok: true })
      return okJson(url.endsWith('/logs') ? { running: false, logs: ['done'] } : { currentVersion: '3.4.6', latestVersion: '3.5.0', updateAvailable: true, running: false, logs: [] })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await expect(getUpdateStatus()).resolves.toMatchObject({ updateAvailable: true })
    await expect(getUpdateLogs()).resolves.toEqual({ running: false, logs: ['done'] })
    await expect(startUpdate()).resolves.toEqual({ ok: true })
    await expect(getUpdateSettings()).resolves.toMatchObject({ enabled: true, provider: 'bitbucket' })
    await expect(saveUpdateSettings({ enabled: false, provider: 'none' })).resolves.toMatchObject({ enabled: true, provider: 'bitbucket' })
    await expect(testUpdateSettings({ enabled: true, provider: 'bitbucket' })).resolves.toEqual({ ok: true })

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://update-runner:9092/status',
      'http://update-runner:9092/logs',
      'http://update-runner:9092/start',
      'http://update-runner:9092/settings',
      'http://update-runner:9092/settings',
      'http://update-runner:9092/test',
    ])
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer update-secret',
    })
    expect(fetchMock.mock.calls[4]![1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ enabled: false, provider: 'none' }),
    })
    expect(fetchMock.mock.calls[5]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ enabled: true, provider: 'bitbucket' }),
    })
  })

  it('maps missing token, non-2xx, and network errors to update_runner_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(getUpdateStatus()).rejects.toBeInstanceOf(UpdateRunnerUnavailableError)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(getUpdateStatus()).rejects.toMatchObject({ code: 'update_runner_unavailable', statusCode: 503 })
  })

  it('preserves actionable update-runner validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'update_settings_invalid',
      message: 'Bitbucket token is required before connection checks can run.',
      details: 'Add a personal access token and try again.',
    }), { status: 422, headers: { 'content-type': 'application/json' } })))

    await expect(saveUpdateSettings({ enabled: true, provider: 'bitbucket' })).rejects.toMatchObject({
      code: 'update_settings_invalid',
      statusCode: 422,
      message: 'Bitbucket token is required before connection checks can run.',
      details: 'Add a personal access token and try again.',
    })
  })

  it('preserves an updater runtime write failure with its request id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'runtime_env_unavailable',
      message: 'Application update settings could not be saved because the runtime environment file is not writable.',
      details: 'Ensure the local installation has a writable .env.persistent-memory file, then try again.',
      requestId: 'update-123',
    }), { status: 500, headers: { 'content-type': 'application/json' } })))

    await expect(saveUpdateSettings({ enabled: false, provider: 'none' })).rejects.toMatchObject({
      code: 'runtime_env_unavailable',
      statusCode: 500,
      requestId: 'update-123',
    })
  })
})
