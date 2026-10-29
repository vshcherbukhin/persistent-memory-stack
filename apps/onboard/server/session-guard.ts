import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

/** Same-origin bootstrap plus a per-process mutation nonce. Host/Origin guard stays in force. */
export function registerMutationNonce(app: FastifyInstance, nonce = randomBytes(24).toString('base64url')): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    const supplied = request.headers['x-pm-onboard-nonce']
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(nonce) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(nonce))) {
      return reply.code(403).send({ error: 'invalid_session_nonce', message: 'The installer session changed or could not be verified. Refresh this page before trying the action again.' })
    }
  })
  app.get('/api/session', async (_request, reply) => reply.header('cache-control', 'no-store').send({ nonce }))
}
