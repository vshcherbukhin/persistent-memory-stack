/**
 * DNS-rebinding guard for the loopback installer server (FIX #13).
 * Covers the pure decision function and a real Fastify onRequest hook wired the
 * same way index.ts wires it, exercised via app.inject().
 */
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { originGuardReason } from '../server/guard.ts'

const PORT = 4319

describe('originGuardReason (pure)', () => {
  it('allows the loopback Host on both 127.0.0.1 and localhost', () => {
    expect(originGuardReason('GET', `127.0.0.1:${PORT}`, undefined, PORT)).toBeNull()
    expect(originGuardReason('GET', `localhost:${PORT}`, undefined, PORT)).toBeNull()
  })
  it('rejects a foreign Host', () => {
    expect(originGuardReason('GET', 'evil.example.com', undefined, PORT)).toBe('bad_host')
    expect(originGuardReason('GET', `127.0.0.1:9999`, undefined, PORT)).toBe('bad_host')
    expect(originGuardReason('GET', undefined, undefined, PORT)).toBe('bad_host')
  })
  it('rejects a POST with a foreign Origin even on a good Host', () => {
    expect(originGuardReason('POST', `127.0.0.1:${PORT}`, 'http://evil.example.com', PORT)).toBe('bad_origin')
  })
  it('allows a POST with a loopback Origin', () => {
    expect(originGuardReason('POST', `localhost:${PORT}`, `http://localhost:${PORT}`, PORT)).toBeNull()
    expect(originGuardReason('POST', `127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`, PORT)).toBeNull()
  })
  it('allows a POST with no Origin (non-browser client)', () => {
    expect(originGuardReason('POST', `127.0.0.1:${PORT}`, undefined, PORT)).toBeNull()
  })
})

/** Build a Fastify app wired exactly like index.ts: guard /api/*, exempt the rest. */
function buildApp() {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return
    const reason = originGuardReason(req.method, req.headers.host, req.headers.origin, PORT)
    if (reason) return reply.code(403).send({ error: reason })
  })
  app.get('/healthz', async () => ({ ok: true }))
  app.get('/api/probe', async () => ({ ok: true }))
  app.post('/api/run', async () => ({ ran: true }))
  return app
}

describe('onRequest guard hook (via inject)', () => {
  it('foreign Host → 403', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/probe', headers: { host: 'evil.example.com' } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'bad_host' })
  })

  it('same-host → passes', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/probe', headers: { host: `127.0.0.1:${PORT}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('POST with foreign Origin → 403', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/run',
      headers: { host: `127.0.0.1:${PORT}`, origin: 'http://evil.example.com' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'bad_origin' })
  })

  it('POST with loopback Origin → passes', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/run',
      headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ran: true })
  })

  it('/healthz is exempt even with a foreign Host', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.example.com' } })
    expect(res.statusCode).toBe(200)
  })
})
