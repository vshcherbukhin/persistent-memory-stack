/**
 * /dashboard/teams — Teams CRUD (Phase 9, control plane). requireAdmin (inherited
 * from the scope). ownerPrisma only.
 *
 * Team delete is gated: the data tables FK to Team with onDelete: Cascade, so a
 * delete would silently destroy that team's memories. Refuse a non-empty team
 * (members OR any data row) with 409 team_not_empty, and require confirm: true
 * even when empty. Counting control-plane rows is legitimate (no memory CONTENT
 * is returned — only integers).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma } from '@pm/db'
import { forbidden } from '../../authz/errors.ts'
import { ConflictError, NotFoundError, isPrismaError, notFoundIfMissing } from './shared.ts'

const TeamOut = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export async function dashboardTeamRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/teams',
    { schema: { response: { 200: z.object({ teams: z.array(TeamOut) }) } } },
    async () => {
      const rows = await ownerPrisma.team.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { members: true } } },
      })
      const teams = (
        rows as { id: string; name: string; createdAt: Date; updatedAt: Date; _count: { members: number } }[]
      ).map((t) => ({
        id: t.id,
        name: t.name,
        memberCount: t._count.members,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }))
      return { teams }
    },
  )

  z4.post(
    '/teams',
    {
      schema: {
        body: z.object({ name: z.string().min(1).max(120) }).strict(),
        response: { 201: TeamOut },
      },
    },
    async (req, reply) => {
      // Only a super-admin may create teams (admins manage only their own team).
      if (!req.identity!.isGlobalSuperuser) {
        throw forbidden('superuser_required', 'Only a super-admin may create teams.')
      }
      try {
        const t = await ownerPrisma.team.create({ data: { name: req.body.name } })
        return reply.code(201).send({ ...t, memberCount: 0 })
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          throw new ConflictError('team_name_taken', `A team named "${req.body.name}" already exists.`)
        }
        throw err
      }
    },
  )

  z4.patch(
    '/teams/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ name: z.string().min(1).max(120) }).strict(),
        response: { 200: TeamOut },
      },
    },
    async (req) => {
      // super-admin renames any team; a team-admin only their OWN team.
      if (!req.identity!.isGlobalSuperuser && req.identity!.teamId !== req.params.id) {
        throw forbidden('cross_team_admin', 'Admins may only rename their own team.')
      }
      try {
        const t = await ownerPrisma.team.update({
          where: { id: req.params.id },
          data: { name: req.body.name },
          include: { _count: { select: { members: true } } },
        })
        const row = t as typeof t & { _count: { members: number } }
        return { id: row.id, name: row.name, memberCount: row._count.members, createdAt: row.createdAt, updatedAt: row.updatedAt }
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          throw new ConflictError('team_name_taken', `A team named "${req.body.name}" already exists.`)
        }
        notFoundIfMissing(err, 'team_not_found', `No team ${req.params.id}.`)
      }
    },
  )

  z4.delete(
    '/teams/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ confirm: z.literal(true) }).strict(),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      // Only a super-admin may delete teams.
      if (!req.identity!.isGlobalSuperuser) {
        throw forbidden('superuser_required', 'Only a super-admin may delete teams.')
      }
      const teamId = req.params.id
      const team = await ownerPrisma.team.findUnique({ where: { id: teamId } })
      if (!team) throw new NotFoundError('team_not_found', `No team ${teamId}.`)

      // Refuse a non-empty team — FK cascade would wipe its memories. Count only.
      const members = await ownerPrisma.appUser.count({ where: { teamId } })
      if (members > 0) {
        throw new ConflictError(
          'team_not_empty',
          `Team has ${members} member(s). Reassign or delete them first — deleting a team cascades and destroys its data.`,
        )
      }
      // Data-presence probe (control-plane row count, no content). Sources +
      // memories are the roots of a team's data; a zero count means no
      // documents/memories/etc. exist, so the cascade is safe.
      const sources = await ownerPrisma.source.count({ where: { teamId } })
      const memories = await ownerPrisma.memory.count({ where: { teamId } })
      if (sources > 0 || memories > 0) {
        throw new ConflictError(
          'team_not_empty',
          `Team still owns data (${sources} source(s), ${memories} memory row(s)). Migrate or purge it before deleting the team.`,
        )
      }

      await ownerPrisma.team.delete({ where: { id: teamId } })
      return reply.code(204).send(null)
    },
  )
}
