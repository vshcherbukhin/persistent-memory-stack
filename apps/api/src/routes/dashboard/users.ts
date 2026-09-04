/**
 * /dashboard/users — Users CRUD + the superuser-only escalation op
 * PATCH /dashboard/users/:id/admin-level. Control plane, ownerPrisma only.
 *
 * ACCESS MODEL (docs/internal/users_roles.md):
 *   • super-admin (global) — CRUD any user of any team, incl. other super-admins.
 *   • team-admin — CRUD only OWN team's users; may observe (GET) all; CANNOT
 *     create/modify/delete a super-admin and CANNOT move a user across teams.
 *   • A plain member / admin is ALWAYS team-bound; only a super-admin may be
 *     team-less (teamId null). create requires a team (adminLevel is firewalled to
 *     'none', so you cannot create a super-admin directly); detaching a user from
 *     their team (teamId=null) is allowed ONLY once they are a super-admin.
 *
 * THE ESCALATION FIREWALL: adminLevel is DELIBERATELY absent from the generic
 * create/update bodies — the only path to mutate it is the dedicated endpoint
 * gated by requireSuperuser. tokenId/tokenHash/tokenExpires are likewise off the
 * bodies (tokens are issued via /dashboard/users/:id/token).
 *
 * LAST-SUPERUSER GUARD: deleting OR demoting the last superuser is refused (409).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma } from '@pm/db'
import { requireSuperuser } from '../../authz/guards.ts'
import { forbidden } from '../../authz/errors.ts'
import { assessPasswordStrength, generateStrongPassword, hashPassword } from '../../auth/password.ts'
import { ConflictError, NotFoundError, USER_SAFE_SELECT, isPrismaError, notFoundIfMissing } from './shared.ts'

const UserOut = z.object({
  id: z.string(),
  teamId: z.string().nullable(),
  adminLevel: z.enum(['none', 'admin', 'superuser']),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  tokenId: z.string().nullable(),
  tokenExpires: z.date().nullable(),
  tokenIssuedAt: z.date().nullable(),
  hasToken: z.boolean(),
  hasPassword: z.boolean(),
  passwordTemporary: z.boolean(),
  passwordChangedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

const PasswordResetOut = z.object({
  user: UserOut,
  password: z.string(),
})

type SafeUser = {
  id: string
  teamId: string | null
  adminLevel: 'none' | 'admin' | 'superuser'
  email: string | null
  displayName: string | null
  tokenId: string | null
  tokenExpires: Date | null
  tokenIssuedAt: Date | null
  passwordHash: string | null
  passwordTemporary: boolean
  passwordChangedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function toOut(u: SafeUser): z.infer<typeof UserOut> {
  return {
    id: u.id,
    teamId: u.teamId,
    adminLevel: u.adminLevel,
    email: u.email,
    displayName: u.displayName,
    tokenId: u.tokenId,
    tokenExpires: u.tokenExpires,
    tokenIssuedAt: u.tokenIssuedAt,
    hasToken: u.tokenId !== null,
    hasPassword: u.passwordHash !== null,
    passwordTemporary: u.passwordTemporary,
    passwordChangedAt: u.passwordChangedAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }
}

/**
 * Control-plane scope for the acting admin. A global super-admin administers any
 * team; a team-admin administers ONLY their own team and never a super-admin.
 * Throws 403 on a cross-team or super-admin target.
 */
function assertCanAdminister(
  req: FastifyRequest,
  target: { teamId: string | null; adminLevel: 'none' | 'admin' | 'superuser' },
): void {
  const id = req.identity!
  if (id.isGlobalSuperuser) return // super-admin → unrestricted
  // team-admin
  if (target.adminLevel === 'superuser') {
    throw forbidden('cannot_modify_superuser', 'Admins cannot create, modify, or delete super-admins.')
  }
  if (target.teamId !== id.teamId) {
    throw forbidden('cross_team_admin', 'Admins may only administer users of their own team.')
  }
}

export async function dashboardUserRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/users',
    {
      schema: {
        querystring: z.object({ teamId: z.string().uuid().optional() }),
        response: { 200: z.object({ users: z.array(UserOut) }) },
      },
    },
    async (req) => {
      // Observation is allowed across all teams (read-only); modification is gated
      // per-write below.
      const where = req.query.teamId ? { teamId: req.query.teamId } : {}
      const rows = (await ownerPrisma.appUser.findMany({
        where,
        select: USER_SAFE_SELECT,
        orderBy: { createdAt: 'asc' },
      })) as SafeUser[]
      return { users: rows.map(toOut) }
    },
  )

  z4.post(
    '/users',
    {
      schema: {
        body: z
          .object({
            teamId: z.string().uuid(), // required — a created user is always team-bound
            email: z.string().email().optional(),
            displayName: z.string().min(1).max(200).optional(),
          })
          .strict(),
        response: { 201: UserOut },
      },
    },
    async (req, reply) => {
      // A new user is a plain member (adminLevel defaults 'none') → scope by team.
      assertCanAdminister(req, { teamId: req.body.teamId, adminLevel: 'none' })
      // FK check up front so a bad teamId is a clean 404, not a P2003 500.
      const team = await ownerPrisma.team.findUnique({ where: { id: req.body.teamId } })
      if (!team) throw new NotFoundError('team_not_found', `No team ${req.body.teamId}.`)
      try {
        const u = (await ownerPrisma.appUser.create({
          data: {
            teamId: req.body.teamId,
            email: req.body.email,
            displayName: req.body.displayName,
            // adminLevel intentionally omitted → defaults to 'none'. No token yet.
          },
          select: USER_SAFE_SELECT,
        })) as SafeUser
        return reply.code(201).send(toOut(u))
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          throw new ConflictError('email_taken', `Email "${req.body.email}" is already in use.`)
        }
        throw err
      }
    },
  )

  z4.get(
    '/users/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: UserOut },
      },
    },
    async (req) => {
      const u = (await ownerPrisma.appUser.findUnique({
        where: { id: req.params.id },
        select: USER_SAFE_SELECT,
      })) as SafeUser | null
      if (!u) throw new NotFoundError('user_not_found', `No user ${req.params.id}.`)
      return toOut(u)
    },
  )

  z4.patch(
    '/users/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        // adminLevel / token* are NOT here — the escalation firewall. teamId is
        // nullable so a super-admin can be detached from their team (→ global).
        body: z
          .object({
            teamId: z.string().uuid().nullable().optional(),
            email: z.string().email().nullable().optional(),
            displayName: z.string().min(1).max(200).nullable().optional(),
          })
          .strict(),
        response: { 200: UserOut },
      },
    },
    async (req) => {
      const target = (await ownerPrisma.appUser.findUnique({
        where: { id: req.params.id },
        select: USER_SAFE_SELECT,
      })) as SafeUser | null
      if (!target) throw new NotFoundError('user_not_found', `No user ${req.params.id}.`)

      // Scope: team-admins administer only own-team, non-super-admin users.
      assertCanAdminister(req, target)
      // A team-admin cannot move a user to another team.
      if (
        !req.identity!.isGlobalSuperuser &&
        req.body.teamId !== undefined &&
        req.body.teamId !== req.identity!.teamId
      ) {
        throw forbidden('cross_team_admin', 'Admins cannot move users to another team.')
      }
      // Detaching from a team (teamId=null) is only valid for a super-admin.
      if (req.body.teamId === null && target.adminLevel !== 'superuser') {
        throw new ConflictError('team_required', 'Only a super-admin may be team-less.')
      }
      // Validate the destination team exists.
      if (req.body.teamId) {
        const team = await ownerPrisma.team.findUnique({ where: { id: req.body.teamId } })
        if (!team) throw new NotFoundError('team_not_found', `No team ${req.body.teamId}.`)
      }
      try {
        const u = (await ownerPrisma.appUser.update({
          where: { id: req.params.id },
          data: {
            teamId: req.body.teamId,
            email: req.body.email,
            displayName: req.body.displayName,
          },
          select: USER_SAFE_SELECT,
        })) as SafeUser
        return toOut(u)
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          throw new ConflictError('email_taken', 'Email is already in use.')
        }
        notFoundIfMissing(err, 'user_not_found', `No user ${req.params.id}.`)
      }
    },
  )

  // ── The escalation firewall: superuser-ONLY admin_level assignment. ─────────
  z4.patch(
    '/users/:id/admin-level',
    {
      preHandler: [requireSuperuser],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ adminLevel: z.enum(['none', 'admin', 'superuser']) }).strict(),
        response: { 200: UserOut },
      },
    },
    async (req) => {
      const target = await ownerPrisma.appUser.findUnique({ where: { id: req.params.id } })
      if (!target) throw new NotFoundError('user_not_found', `No user ${req.params.id}.`)

      // An 'admin' must be team-bound (only a super-admin may be team-less).
      if (req.body.adminLevel === 'admin' && target.teamId === null) {
        throw new ConflictError(
          'team_required',
          'An admin must belong to a team. Assign a team before granting admin.',
        )
      }

      // Demoting the last superuser would lock the org out of the control plane.
      if (target.adminLevel === 'superuser' && req.body.adminLevel !== 'superuser') {
        const superusers = await ownerPrisma.appUser.count({ where: { adminLevel: 'superuser' } })
        if (superusers <= 1) {
          throw new ConflictError(
            'last_superuser',
            'Cannot demote the last superuser — promote another user to superuser first.',
          )
        }
      }

      const u = (await ownerPrisma.appUser.update({
        where: { id: req.params.id },
        data: { adminLevel: req.body.adminLevel },
        select: USER_SAFE_SELECT,
      })) as SafeUser
      return toOut(u)
    },
  )

  z4.post(
    '/users/:id/password-reset',
    {
      preHandler: [requireSuperuser],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ password: z.string().min(1).max(200).optional() }).strict().optional(),
        response: {
          200: PasswordResetOut,
          400: z.object({ error: z.string(), message: z.string().optional() }),
        },
      },
    },
    async (req, reply) => {
      const target = await ownerPrisma.appUser.findUnique({ where: { id: req.params.id }, select: { id: true } })
      if (!target) throw new NotFoundError('user_not_found', `No user ${req.params.id}.`)

      const password = req.body?.password ?? generateStrongPassword()
      const strength = assessPasswordStrength(password)
      if (!strength.accepted) {
        return reply.code(400).send({ error: 'weak_password', message: strength.messages.join(' ') })
      }

      const u = (await ownerPrisma.appUser.update({
        where: { id: req.params.id },
        data: {
          passwordHash: await hashPassword(password),
          passwordTemporary: true,
          passwordChangedAt: new Date(),
        },
        select: USER_SAFE_SELECT,
      })) as SafeUser
      return { user: toOut(u), password }
    },
  )

  z4.delete(
    '/users/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ confirm: z.literal(true) }).strict(),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const target = (await ownerPrisma.appUser.findUnique({
        where: { id: req.params.id },
        select: USER_SAFE_SELECT,
      })) as SafeUser | null
      if (!target) throw new NotFoundError('user_not_found', `No user ${req.params.id}.`)

      // Scope: team-admins delete only own-team, non-super-admin users.
      assertCanAdminister(req, target)

      if (target.adminLevel === 'superuser') {
        const superusers = await ownerPrisma.appUser.count({ where: { adminLevel: 'superuser' } })
        if (superusers <= 1) {
          throw new ConflictError(
            'last_superuser',
            'Cannot delete the last superuser — promote another user to superuser first.',
          )
        }
      }

      await ownerPrisma.appUser.delete({ where: { id: req.params.id } })
      return reply.code(204).send(null)
    },
  )
}
