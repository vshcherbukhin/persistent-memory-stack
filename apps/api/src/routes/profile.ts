/**
 * /profile — self-service identity for the CURRENT caller (P1, full-local redesign).
 *
 * Registered INSIDE the secured scope (req.identity is set by the auth hook — the local
 * super-user in local mode, the token user in server mode). app_user is a CONTROL table
 * (outside RLS) → ownerPrisma. Lets a user edit their displayName/email and set/clear
 * the optional local-dashboard password.
 *
 *   GET  /profile          → the caller's profile (+ hasPassword boolean)
 *   PUT  /profile          → update displayName/email; set (password) or clear (removePassword)
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma, Prisma } from '@pm/db'
import { assessPasswordStrength, hashPassword, verifyPassword } from '../auth/password.ts'
import { issueToken } from '../auth/token-service.ts'
import { config } from '../config.ts'
import { forbidden } from '../authz/errors.ts'

const ProfileOut = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  adminLevel: z.enum(['none', 'admin', 'superuser']),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  hasPassword: z.boolean(),
  passwordTemporary: z.boolean(),
  recoveryToken: z.string().optional(),
})

async function loadProfile(userId: string): Promise<z.infer<typeof ProfileOut>> {
  const u = await ownerPrisma.appUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      email: true,
      adminLevel: true,
      teamId: true,
      passwordHash: true,
      passwordTemporary: true,
    },
  })
  if (!u) throw new Error('identity row missing') // auth derived it from a real row
  const teamName = u.teamId
    ? (await ownerPrisma.team.findUnique({ where: { id: u.teamId }, select: { name: true } }))?.name ?? null
    : null
  return {
    userId: u.id,
    displayName: u.displayName,
    email: u.email,
    adminLevel: u.adminLevel,
    teamId: u.teamId,
    teamName,
    hasPassword: u.passwordHash !== null,
    passwordTemporary: u.passwordTemporary,
  }
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get('/profile', { schema: { response: { 200: ProfileOut } } }, async (req) => loadProfile(req.identity!.userId))

  z4.put(
    '/profile',
    {
      schema: {
        body: z
          .object({
            displayName: z.string().min(1).max(200).nullable().optional(),
            email: z.string().email().nullable().optional(),
            currentPassword: z.string().min(1).max(200).optional(),
            password: z.string().min(1).max(200).optional(), // set / change
            removePassword: z.boolean().optional(), // clear → dashboard opens freely again
          })
          .strict(),
        response: {
          200: ProfileOut,
          400: z.object({ error: z.string(), message: z.string().optional() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const userId = req.identity!.userId
      const data: Record<string, unknown> = {}
      let rotateRecoveryToken = false
      if (req.body.displayName !== undefined) data.displayName = req.body.displayName
      if (req.body.email !== undefined) data.email = req.body.email
      // removePassword wins over password (explicit clear).
      if (req.body.removePassword) {
        if (config.DEPLOYMENT_MODE !== 'local') {
          throw forbidden('password_required', 'Server-mode users cannot remove their dashboard password.')
        }
        data.passwordHash = null
        data.passwordTemporary = false
        data.passwordChangedAt = new Date()
      } else if (req.body.password !== undefined) {
        const current = await ownerPrisma.appUser.findUnique({
          where: { id: userId },
          select: { passwordHash: true, passwordTemporary: true, adminLevel: true },
        })
        if (current?.passwordHash) {
          if (!req.body.currentPassword || !(await verifyPassword(current.passwordHash, req.body.currentPassword))) {
            throw forbidden('current_password_required', 'Enter your current password before setting a new one.')
          }
        }
        const strength = assessPasswordStrength(req.body.password)
        if (!strength.accepted) {
          return reply.code(400).send({ error: 'weak_password', message: strength.messages.join(' ') })
        }
        data.passwordHash = await hashPassword(req.body.password)
        data.passwordTemporary = false
        data.passwordChangedAt = new Date()
        rotateRecoveryToken = current?.adminLevel === 'superuser' && current.passwordTemporary
      }

      try {
        await ownerPrisma.appUser.update({ where: { id: userId }, data })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return reply.code(409).send({ error: 'email_taken' })
        }
        throw err
      }
      const profile = await loadProfile(userId)
      if (!rotateRecoveryToken) return profile

      const issued = await issueToken(userId, null)
      return { ...profile, recoveryToken: issued.wireToken }
    },
  )
}
