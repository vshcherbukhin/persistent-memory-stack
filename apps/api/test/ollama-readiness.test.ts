import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { createOllamaReadiness } from '../src/services/ollama-readiness.ts'

const target = { model: 'qwen3-embedding:4b', dim: 2 }
const models = { models: [{ name: target.model }] }
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('Ollama readiness', () => {
  it('refreshes a near-expiry resident lease without inference, waiting, or another Starting transition', async () => {
    let time = 0, expiresAt = 300_000
    let finishLease!: (response: Response) => void
    const bodies: Array<{ input: string[]; keep_alive: string }> = []
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/embed')) {
        const body = JSON.parse(String(init?.body)); bodies.push(body)
        if (body.input.length === 0) return new Promise<Response>(resolve => { finishLease = resolve })
        return response({ embeddings: [[1, 2]] })
      }
      return response({ models: [{ name: target.model, expires_at: new Date(expiresAt).toISOString() }] })
    })
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', fetch: request, now: () => time, cacheMs: 0 })
    await readiness.inspect(target)
    await vi.waitFor(async () => expect((await readiness.inspect(target)).state).toBe('ready'))
    time = 245_000
    const samples = await Promise.all(Array.from({ length: 12 }, () => readiness.inspect(target)))
    expect(samples.every(sample => sample.state === 'ready')).toBe(true)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual({ model: target.model, input: [], keep_alive: '5m' })
    time = 250_000
    expect((await readiness.inspect(target)).state).toBe('ready')
    expect(bodies).toHaveLength(2)
    expiresAt = time + 300_000
    finishLease(response({ embeddings: [] }))
    await Promise.resolve()
    time = 260_000
    expect((await readiness.inspect(target)).state).toBe('ready')
    expect(bodies.filter(body => body.input.length > 0)).toHaveLength(1)
  })

  it('backs off failed lease renewals and still detects a genuinely unloaded model', async () => {
    let time = 0, resident = true
    const bodies: Array<{ input: string[] }> = []
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', now: () => time, cacheMs: 0, fetch: vi.fn(async (url, init) => {
      if (String(url).endsWith('/api/embed')) {
        const body = JSON.parse(String(init?.body)); bodies.push(body)
        return body.input.length === 0 ? new Response('unavailable', { status: 503 }) : response({ embeddings: [[1, 2]] })
      }
      return response(String(url).endsWith('/api/ps') && !resident ? { models: [] } : { models: [{ name: target.model, expires_at: new Date(300_000).toISOString() }] })
    }) })
    await readiness.inspect(target)
    await vi.waitFor(async () => expect((await readiness.inspect(target)).state).toBe('ready'))
    time = 245_000
    expect((await readiness.inspect(target)).state).toBe('ready')
    await Promise.resolve(); await Promise.resolve()
    time = 250_000
    expect((await readiness.inspect(target)).state).toBe('ready')
    expect(bodies.filter(body => body.input.length === 0)).toHaveLength(1)
    resident = false; time = 251_000
    expect((await readiness.inspect(target)).state).toBe('starting')
  })
  it('bounds a stalled metadata response body, not just its headers', async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"models":') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    try {
      const readiness = createOllamaReadiness({ baseUrl: `http://127.0.0.1:${address.port}`, checkTimeoutMs: 80, startupGraceMs: 0 })
      const start = performance.now()
      expect((await readiness.inspect(target)).state).toBe('unavailable')
      expect(performance.now() - start).toBeLessThan(1800)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('returns starting promptly while one shared synthetic warm-up runs, then becomes ready', async () => {
    let finish!: (value: Response) => void
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/embed')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: target.model, input: ['Embedding readiness check.'], keep_alive: '5m', dimensions: 2 })
        return new Promise<Response>(resolve => { finish = resolve })
      }
      return response(models)
    })
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', fetch: request })
    const values = await Promise.all(Array.from({ length: 12 }, () => readiness.inspect(target)))
    expect(values.every(value => value.state === 'starting')).toBe(true)
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/api/embed'))).toHaveLength(1)
    finish(response({ embeddings: [[0.2, 0.8]] }))
    await vi.waitFor(async () => expect((await readiness.inspect(target)).state).toBe('ready'))
  })

  it('detects a model that unloaded after success rather than trusting old health', async () => {
    let time = 0, resident = true, delay = false
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/embed')) return delay ? new Promise<Response>(() => {}) : response({ embeddings: [[1, 2]] })
      return response(String(url).endsWith('/api/ps') && !resident ? { models: [] } : models)
    })
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', fetch: request, now: () => time })
    expect((await readiness.inspect(target)).state).toBe('starting')
    await vi.waitFor(async () => expect((await readiness.inspect(target)).state).toBe('ready'))
    time = 2_000; resident = false; delay = true
    expect((await readiness.inspect(target)).state).toBe('starting')
    expect((await readiness.inspect(target)).readyAt).toBeNull()
  })

  it('never treats a model list or malformed/wrong-width vector as ready', async () => {
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', fetch: vi.fn(async url => response(String(url).endsWith('/api/embed') ? { embeddings: [[1]] } : models)) })
    expect((await readiness.inspect(target)).state).toBe('starting')
    await vi.waitFor(async () => expect((await readiness.inspect(target)).state).toBe('invalid_embedding'))
  })

  it('reports a missing model without pulling, warming or changing configuration', async () => {
    const request = vi.fn(async () => response({ models: [] }))
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', fetch: request })
    expect((await readiness.inspect(target)).state).toBe('model_missing')
    expect(request.mock.calls).toHaveLength(2)
  })

  it('reports an unreachable host promptly and does not leak provider text', async () => {
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', startupGraceMs: 0, fetch: vi.fn(async () => { throw new Error('private provider details') }) })
    const result = await readiness.inspect(target)
    expect(result.state).toBe('unavailable')
    expect(result.message).not.toContain('private')
  })

  it('shows initial host launch as starting, but a persistently absent host becomes unavailable', async () => {
    let time = 0
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', now: () => time, fetch: vi.fn(async () => { throw new Error('connect refused') }) })
    expect((await readiness.inspect(target)).state).toBe('starting')
    time = 121_000
    expect((await readiness.inspect(target)).state).toBe('unavailable')
  })

  it('a previous pin completion cannot mark the new pin ready', async () => {
    const waiting: Array<(value: Response) => void> = []
    const readiness = createOllamaReadiness({ baseUrl: 'http://ollama', fetch: vi.fn(async url => String(url).endsWith('/api/embed')
      ? new Promise<Response>(resolve => waiting.push(resolve)) : response(models)) })
    await readiness.inspect(target)
    await readiness.inspect({ ...target, dim: 3 })
    waiting[0]!(response({ embeddings: [[1, 2]] }))
    await Promise.resolve()
    expect((await readiness.inspect({ ...target, dim: 3 })).state).toBe('starting')
    waiting[1]!(response({ embeddings: [[1, 2, 3]] }))
    await vi.waitFor(async () => expect((await readiness.inspect({ ...target, dim: 3 })).state).toBe('ready'))
  })
})
