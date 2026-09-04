/**
 * /local/auth — the OPTIONAL local-dashboard password gate (P1, full-local redesign).
 *
 * Registered OUTSIDE the secured scope (public, no identity) and ONLY when
 * DEPLOYMENT_MODE=local (app.ts). This is a dashboard-UI SOFT LOCK: it lets the admin
 * app ask "is a password configured?" and verify it. The local API/MCP themselves stay
 * no-auth by design (single-user local machine) — this endpoint does NOT gate them; it
 * only backs the dashboard's optional login.
 *
 *   GET  /local/auth            → { passwordSet }  (should the dashboard show a login?)
 *   POST /local/auth {password} → { ok }           (verify; 400 when no password set)
 *
 * Brute-force resistance is deliberately small and in-process because this is a
 * loopback-only convenience gate: 5 failed attempts/minute/IP, reset on success,
 * plus argon2id's intrinsic verify cost.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { localPasswordHash } from '../auth/local-mode.ts'
import { verifyPassword } from '../auth/password.ts'

export interface LocalAuthLimiter {
  isLimited(ip: string): boolean
  recordFailure(ip: string): void
  recordSuccess(ip: string): void
}

export function createLocalAuthLimiter(opts: {
  now?: () => number
  maxFailures?: number
  windowMs?: number
} = {}): LocalAuthLimiter {
  const now = opts.now ?? (() => Date.now())
  const maxFailures = opts.maxFailures ?? 5
  const windowMs = opts.windowMs ?? 60_000
  const failures = new Map<string, { count: number; startedAt: number }>()

  function current(ip: string): { count: number; startedAt: number } | undefined {
    const rec = failures.get(ip)
    if (!rec) return undefined
    if (now() - rec.startedAt > windowMs) {
      failures.delete(ip)
      return undefined
    }
    return rec
  }

  return {
    isLimited(ip) {
      const rec = current(ip)
      return !!rec && rec.count >= maxFailures
    },
    recordFailure(ip) {
      const rec = current(ip)
      if (!rec) {
        failures.set(ip, { count: 1, startedAt: now() })
        return
      }
      rec.count += 1
    },
    recordSuccess(ip) {
      failures.delete(ip)
    },
  }
}

const localAuthLimiter = createLocalAuthLimiter()

export async function localAuthRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/local/auth',
    { schema: { response: { 200: z.object({ passwordSet: z.boolean() }) } } },
    async () => {
      return { passwordSet: !!(await localPasswordHash()) }
    },
  )

  z4.post(
    '/local/auth',
    {
      schema: {
        body: z.object({ password: z.string() }),
        response: {
          200: z.object({ ok: z.boolean() }),
          400: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown'
      if (localAuthLimiter.isLimited(ip)) {
        return reply.code(429).send({ error: 'rate_limited' })
      }

      const passwordHash = await localPasswordHash()
      if (!passwordHash) {
        return reply.code(400).send({ error: 'no_password_set' })
      }
      const ok = await verifyPassword(passwordHash, req.body.password)
      if (ok) localAuthLimiter.recordSuccess(ip)
      else localAuthLimiter.recordFailure(ip)
      return reply.code(200).send({ ok })
    },
  )
}
