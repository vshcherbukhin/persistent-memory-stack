import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { dashboardUpdateRoutes } from '../src/routes/dashboard/update.ts'

vi.mock('../src/config.ts', () => ({
  config: { UPDATE_RUNNER_URL: 'http://update-runner:9092', UPDATE_RUNNER_TOKEN: 'update-secret' },
}))

import { UpdateRunnerUnavailableError, getUpdateLogs, getUpdateStatus, startUpdate } from '../src/services/update-runner.ts'

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const status = {
  releaseLine: 'public-v1',
  lastSuccessfulUpdate: { releaseLine: 'public-v1', id: 'public-marker', source: 'update-runner', version: '4.0.35', finishedAt: '2026-09-06T00:00:00Z' },
  currentVersion: '4.0.35', latestVersion: '4.0.36', updateAvailable: true, updateBranch: 'master', running: false, logs: [],
}

afterEach(() => vi.unstubAllGlobals())

describe('update-runner client', () => {
  it('forwards status/log/start calls using only the internal sidecar bearer token', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => okJson(init.method === 'POST' ? { ok: true } : url.endsWith('/logs') ? { running: false, logs: ['done'] } : status))
    vi.stubGlobal('fetch', fetchMock)
    await expect(getUpdateStatus()).resolves.toEqual(status)
    await expect(getUpdateLogs()).resolves.toEqual({ running: false, logs: ['done'] })
    await expect(startUpdate()).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://update-runner:9092/status', 'http://update-runner:9092/logs', 'http://update-runner:9092/start',
    ])
    for (const [, request] of fetchMock.mock.calls) {
      expect(request.headers).toEqual({ authorization: 'Bearer update-secret' })
      expect(request.body).toBeUndefined()
    }
  })

  it('maps unavailable sidecar and network errors to update_runner_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(getUpdateStatus()).rejects.toBeInstanceOf(UpdateRunnerUnavailableError)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(getUpdateStatus()).rejects.toMatchObject({ code: 'update_runner_unavailable', statusCode: 503 })
  })

  it('preserves actionable update preflight failures without claiming an update started', async () => {
    const failure = { error: 'update_source_invalid', message: 'The checkout origin does not match the public release repository.', details: 'Run the updater from the Persistent Memory checkout.', requestId: 'update-123' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(failure), { status: 422 })))
    await expect(startUpdate()).rejects.toMatchObject({ code: failure.error, statusCode: 422, message: failure.message, details: failure.details, requestId: failure.requestId })
  })
})

async function routeApp(adminLevel?: 'admin' | 'superuser') {
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  if (adminLevel) app.addHook('onRequest', async (req) => {
    req.identity = { userId: 'test-user', teamId: null, adminLevel, isTeamMember: false, isTeamAdmin: false, isGlobalSuperuser: adminLevel === 'superuser' }
  })
  await app.register(dashboardUpdateRoutes, { prefix: '/dashboard' })
  return app
}

describe('automatic update API contract', () => {
  it('returns the public master release status without requiring a settings or connection-test call', async () => {
    const fetchMock = vi.fn(async () => okJson(status))
    vi.stubGlobal('fetch', fetchMock)
    const app = await routeApp('superuser')
    try {
      const response = await app.inject({ method: 'GET', url: '/dashboard/update' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(status)
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://update-runner:9092/status', expect.objectContaining({ method: 'GET' }))
    } finally { await app.close() }
  })

  it('retains explicit start and log routes', async () => {
    const fetchMock = vi.fn(async (url: string) => okJson(url.endsWith('/start') ? { ok: true } : { running: false, logs: ['Update complete'] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = await routeApp('superuser')
    try {
      const start = await app.inject({ method: 'POST', url: '/dashboard/update/start' })
      expect(start.statusCode).toBe(202)
      expect(start.json()).toEqual({ ok: true })
      const logs = await app.inject({ method: 'GET', url: '/dashboard/update/logs' })
      expect(logs.statusCode).toBe(200)
      expect(logs.json()).toEqual({ running: false, logs: ['Update complete'] })
    } finally { await app.close() }
  })

  it('does not expose any endpoint that can configure or disable public update checks', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = await routeApp('superuser')
    try {
      for (const request of [
        { method: 'GET' as const, url: '/dashboard/update/settings' },
        { method: 'PATCH' as const, url: '/dashboard/update/settings', payload: { enabled: false } },
        { method: 'POST' as const, url: '/dashboard/update/test', payload: {} },
      ]) {
        expect(app.hasRoute({ method: request.method, url: request.url })).toBe(false)
        expect((await app.inject(request)).statusCode).toBe(404)
      }
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it.each([undefined, 'admin'] as const)('keeps status, logs and explicit installation restricted to superusers (%s)', async (adminLevel) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = await routeApp(adminLevel)
    try {
      for (const request of [
        { method: 'GET' as const, url: '/dashboard/update' },
        { method: 'GET' as const, url: '/dashboard/update/logs' },
        { method: 'POST' as const, url: '/dashboard/update/start' },
      ]) expect((await app.inject(request)).statusCode).toBe(adminLevel ? 403 : 401)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('preserves a failed start response with its details and request id', async () => {
    const failure = { error: 'update_source_invalid', message: 'The update source could not be verified.', details: 'Check the repository origin.', requestId: 'update-test-123' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(failure), { status: 422 })))
    const app = await routeApp('superuser')
    try {
      const response = await app.inject({ method: 'POST', url: '/dashboard/update/start' })
      expect(response.statusCode).toBe(422)
      expect(response.json()).toEqual(failure)
    } finally { await app.close() }
  })
})
