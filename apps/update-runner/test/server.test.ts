import { describe, expect, it, vi } from 'vitest'
import { authOk, createServer, route, type UpdateRunnerOps } from '../src/server.ts'
const ops = (overrides: Partial<UpdateRunnerOps> = {}): UpdateRunnerOps => ({
  status: vi.fn(async () => ({ releaseLine: 'public-v1', currentVersion: '3.4.6', latestVersion: '3.5.0', updateAvailable: true, running: false, logs: [] })),
  start: vi.fn(async () => ({ ok: true })),
  logs: vi.fn(async () => ({ running: false, logs: ['done'] })),
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

  it.each([['GET', '/settings'], ['PATCH', '/settings'], ['POST', '/test']])('does not expose the removed %s %s route', async (method, path) => {
    const o = ops()
    await expect(route(method, path, new URLSearchParams(), o)).resolves.toEqual({ status: 404, body: { error: 'not_found' } })
    expect(o.start).not.toHaveBeenCalled()
    expect(o.status).not.toHaveBeenCalled()
  })

  it('logs a safe request identifier when an updater request fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = createServer({
      token: 'secret',
      ops: ops({ status: vi.fn(async () => { throw new Error('private fixture failure') }) }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not listen')
      const response = await fetch(`http://127.0.0.1:${address.port}/status`, {
        method: 'GET',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      })
      await expect(response.json()).resolves.toMatchObject({ error: 'internal', requestId: expect.any(String) })
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('GET /status'))
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
      errorSpy.mockRestore()
    }
  })
})
