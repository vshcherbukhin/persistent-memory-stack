/**
 * /dashboard/users/:id/token — issue / rotate / revoke a user's opaque token
 * (Phase 9, requireAdmin, ownerPrisma via the token-service).
 *
 * SHOW-ONCE: POST (issue) and POST .../rotate return the FULL wire token
 * `${tokenId}.${secret}` in the response body EXACTLY ONCE. Only tokenId +
 * argon2id(tokenHash) persist; the plaintext is never stored or logged (app.ts
 * redacts the Authorization header; this body must not be logged either). Issue
 * and rotate are the same mint operation — rotate is the name used when a token
 * already exists (the old token stops verifying because tokenId changed). Revoke
 * NULLs the hash; the user row + audit survive.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma } from '@pm/db'
import { issueToken, revokeToken } from '../../auth/token-service.ts'
import { NotFoundError, notFoundIfMissing } from './shared.ts'

const IssuedOut = z.object({
  tokenId: z.string(),
  wireToken: z.string(),
  expiresAt: z.date().nullable(),
})

const Body = z
  .object({
    // Accept an ISO string or epoch; null/absent → non-expiring.
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict()

export async function dashboardTokenRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // Shared issue/rotate handler — both mint a fresh token and return it once.
  const mint = async (id: string, expiresAt: Date | null) => {
    const exists = await ownerPrisma.appUser.findUnique({ where: { id }, select: { id: true } })
    if (!exists) throw new NotFoundError('user_not_found', `No user ${id}.`)
    return issueToken(id, expiresAt)
  }

  z4.post(
    '/users/:id/token',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: Body,
        response: { 201: IssuedOut },
      },
    },
    async (req, reply) => {
      const issued = await mint(req.params.id, req.body.expiresAt ?? null)
      return reply.code(201).send(issued)
    },
  )

  z4.post(
    '/users/:id/token/rotate',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: Body,
        response: { 201: IssuedOut },
      },
    },
    async (req, reply) => {
      const issued = await mint(req.params.id, req.body.expiresAt ?? null)
      return reply.code(201).send(issued)
    },
  )

  z4.delete(
    '/users/:id/token',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      try {
        await revokeToken(req.params.id)
      } catch (err) {
        notFoundIfMissing(err, 'user_not_found', `No user ${req.params.id}.`)
      }
      return reply.code(204).send(null)
    },
  )
}
