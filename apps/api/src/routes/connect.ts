/**
 * Minimal "connect this local dashboard" surface.
 *
 * This route is intentionally outside /dashboard: regular users and team admins
 * need a way to mint their own connector credential after authenticating with
 * the server (password today, SSO-backed session when the provider is wired)
 * without gaining access to the super-admin operator console.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { config } from '../config.ts'
import { issueToken } from '../auth/token-service.ts'

const Body = z
  .object({
    // Null/absent keeps the existing token-service non-expiring behavior.
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict()

const ConnectorOut = z.object({
  tokenId: z.string(),
  wireToken: z.string(),
  expiresAt: z.date().nullable(),
  user: z.object({
    id: z.string().uuid(),
    teamId: z.string().uuid().nullable(),
    adminLevel: z.enum(['none', 'admin', 'superuser']),
  }),
})

export async function connectRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.post(
    '/connect/local-dashboard/token',
    {
      schema: {
        body: Body,
        response: {
          201: ConnectorOut,
          400: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      if (config.DEPLOYMENT_MODE === 'local') {
        return reply.code(400).send({
          error: 'local_mode_not_supported',
          message: 'A local personal stack does not need a shared-memory connector token.',
        })
      }
      const id = req.identity!
      const issued = await issueToken(id.userId, req.body.expiresAt ?? null)
      return reply.code(201).send({
        ...issued,
        user: {
          id: id.userId,
          teamId: id.teamId,
          adminLevel: id.adminLevel,
        },
      })
    },
  )
}
