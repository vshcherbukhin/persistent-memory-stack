import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerMutationNonce } from '../server/session-guard.ts'
import { originGuardReason } from '../server/guard.ts'

const nonce = 'A'.repeat(32)
function fixture() {
  const app = Fastify({ logger: false })
  let actions = 0
  app.addHook('onRequest', async (request, reply) => {
    const reason = originGuardReason(request.method, request.headers.host, request.headers.origin, 4319)
    if (reason) return reply.code(403).send({ error: reason })
  })
  registerMutationNonce(app, nonce)
  app.post('/api/action', async () => ({ actions: ++actions }))
  return { app, actions: () => actions }
}
const headers = { host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' }

describe('wizard mutation session', () => {
  it('returns a no-store nonce for the local page, rejects missing/wrong nonce before action, and permits explicit valid action', async () => {
    const { app, actions } = fixture()
    try {
      const session = await app.inject({ method: 'GET', url: '/api/session', headers })
      expect(session.json()).toEqual({ nonce })
      expect(session.headers['cache-control']).toBe('no-store')
      for (const candidate of [undefined, 'B'.repeat(32), 'short']) {
        const response = await app.inject({ method: 'POST', url: '/api/action', headers: { ...headers, ...(candidate ? { 'x-pm-onboard-nonce': candidate } : {}) }, payload: { nonce } })
        expect(response.statusCode).toBe(403)
        expect(response.json().error).toBe('invalid_session_nonce')
      }
      expect(actions()).toBe(0)
      expect((await app.inject({ method: 'POST', url: '/api/action', headers: { ...headers, 'x-pm-onboard-nonce': nonce } })).statusCode).toBe(200)
      expect(actions()).toBe(1)
    } finally { await app.close() }
  })
  it('preserves Host/Origin rejection even with the correct nonce', async () => {
    const { app, actions } = fixture()
    try {
      for (const foreign of [{ ...headers, host: 'evil.example' }, { ...headers, origin: 'https://evil.example' }]) {
        expect((await app.inject({ method: 'POST', url: '/api/action', headers: { ...foreign, 'x-pm-onboard-nonce': nonce } })).statusCode).toBe(403)
      }
      expect(actions()).toBe(0)
    } finally { await app.close() }
  })
})
