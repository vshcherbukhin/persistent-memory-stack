/**
 * Public dashboard login routes. Server mode uses email/password for humans and
 * keeps PM wire tokens for MCP/API/recovery access. Local mode continues to use
 * /local/auth as the optional soft lock.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma } from '@pm/db'
import { verifyPassword } from '../auth/password.ts'
import { issueDashboardSession } from '../auth/dashboard-session.ts'
import { config } from '../config.ts'
import { getEffectiveSettings } from '../services/settings.ts'

const LoginOut = z.object({
  sessionToken: z.string(),
  passwordTemporary: z.boolean(),
})

export async function dashboardAuthRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.post(
    '/auth/login/password',
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(1),
        }).strict(),
        response: {
          200: LoginOut,
          400: z.object({ error: z.string() }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      if (config.DEPLOYMENT_MODE === 'local') {
        return reply.code(400).send({ error: 'local_mode_uses_local_auth' })
      }
      const settings = await getEffectiveSettings()
      if (settings.dashboardLoginMode === 'sso') {
        return reply.code(400).send({ error: 'sso_login_enabled' })
      }
      const email = req.body.email.trim()
      const user = await ownerPrisma.appUser.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
      if (!user?.passwordHash) return reply.code(401).send({ error: 'invalid_credentials' })
      const ok = await verifyPassword(user.passwordHash, req.body.password)
      if (!ok) return reply.code(401).send({ error: 'invalid_credentials' })
      return {
        sessionToken: issueDashboardSession({ userId: user.id }),
        passwordTemporary: user.passwordTemporary,
      }
    },
  )
}
