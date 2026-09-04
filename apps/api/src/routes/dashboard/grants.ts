/**
 * /dashboard/grants — team→team read-grant matrix (Phase 9, requireAdmin,
 * ownerPrisma).
 *
 * DIRECTIONALITY (locked): TeamGrant(grantorTeamId, granteeTeamId) means
 * "grantor's data is readable by grantee". Cross-team grants are READ-ONLY;
 * writes never cross teams. The UI renders rows = grantor ("data owner"), cols =
 * grantee ("reader"); a checked cell (X,Y) reads "Y can read X" and corresponds
 * to TeamGrant(grantor=X, grantee=Y). resolveReadableTeams reads grants WHERE
 * granteeTeamId = ownTeam and returns the grantor ids — so cell (X,Y) widens Y's
 * readable set to include X.
 *
 * SELF-GRANT: grantor === grantee is rejected (400) — a team always reads itself
 * (the diagonal is implicit/disabled in the UI), so a self-grant is meaningless.
 * Toggle is by composite (grantor+grantee), not id, so the UI can flip a cell
 * knowing only the two team ids.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma } from '@pm/db'
import { forbidden } from '../../authz/errors.ts'
import { NotFoundError, isPrismaError } from './shared.ts'

const GrantOut = z.object({
  id: z.string(),
  grantorTeamId: z.string(),
  granteeTeamId: z.string(),
})

const Pair = z
  .object({
    grantorTeamId: z.string().uuid(),
    granteeTeamId: z.string().uuid(),
  })
  .strict()

export async function dashboardGrantRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // The matrix payload: all teams (for axes) + all grant rows. The UI builds the
  // grid client-side. team list is the same shape /dashboard/teams uses minus counts.
  z4.get(
    '/grants',
    {
      schema: {
        response: {
          200: z.object({
            teams: z.array(z.object({ id: z.string(), name: z.string() })),
            grants: z.array(GrantOut),
          }),
        },
      },
    },
    async () => {
      const [teams, grants] = await Promise.all([
        ownerPrisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        ownerPrisma.teamGrant.findMany({
          select: { id: true, grantorTeamId: true, granteeTeamId: true },
        }),
      ])
      return {
        teams: teams as { id: string; name: string }[],
        grants: grants as { id: string; grantorTeamId: string; granteeTeamId: string }[],
      }
    },
  )

  z4.post(
    '/grants',
    { schema: { body: Pair, response: { 201: GrantOut } } },
    async (req, reply) => {
      const { grantorTeamId, granteeTeamId } = req.body
      if (grantorTeamId === granteeTeamId) {
        throw forbidden(
          'self_grant',
          'A team always reads its own data — a self-grant is meaningless. Pick two different teams.',
        )
      }
      // FK presence → clean 404 instead of a P2003 500.
      const [grantor, grantee] = await Promise.all([
        ownerPrisma.team.findUnique({ where: { id: grantorTeamId }, select: { id: true } }),
        ownerPrisma.team.findUnique({ where: { id: granteeTeamId }, select: { id: true } }),
      ])
      if (!grantor) throw new NotFoundError('team_not_found', `No grantor team ${grantorTeamId}.`)
      if (!grantee) throw new NotFoundError('team_not_found', `No grantee team ${granteeTeamId}.`)

      try {
        const g = await ownerPrisma.teamGrant.create({ data: { grantorTeamId, granteeTeamId } })
        return reply.code(201).send(g)
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          // Idempotent: the grant already exists — return it.
          const existing = await ownerPrisma.teamGrant.findUnique({
            where: { grantorTeamId_granteeTeamId: { grantorTeamId, granteeTeamId } },
          })
          return reply.code(201).send(existing!)
        }
        throw err
      }
    },
  )

  z4.delete(
    '/grants',
    { schema: { body: Pair, response: { 204: z.null() } } },
    async (req, reply) => {
      const { grantorTeamId, granteeTeamId } = req.body
      const res = await ownerPrisma.teamGrant.deleteMany({
        where: { grantorTeamId, granteeTeamId },
      })
      if (res.count === 0) {
        throw new NotFoundError('grant_not_found', 'No such grant to revoke.')
      }
      return reply.code(204).send(null)
    },
  )
}
