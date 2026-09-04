/**
 * GET /whoami — returns the server-DERIVED identity + role booleans.
 *
 * Registered INSIDE the secured scope (the authenticate hook has already run and
 * populated request.identity). Proves the identity layer end to end: the client
 * asserts nothing; everything here came from the token. teamId is nullable (a
 * team-less independent super-admin); the booleans encode the access model
 * (docs/internal/users_roles.md) so the dashboard can gate its UI.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma, type TenantCtx } from '@pm/db'
import { config } from '../config.ts'

export interface WhoamiProfile {
  teamName: string | null
  userDisplayName: string | null
  userEmail: string | null
}

export async function readWhoamiProfile(id: TenantCtx): Promise<WhoamiProfile> {
  const [team, user] = await Promise.all([
    id.teamId ? ownerPrisma.team.findUnique({ where: { id: id.teamId }, select: { name: true } }) : Promise.resolve(null),
    ownerPrisma.appUser.findUnique({ where: { id: id.userId }, select: { displayName: true, email: true } }),
  ])
  return {
    teamName: team?.name ?? null,
    userDisplayName: user?.displayName ?? null,
    userEmail: user?.email ?? null,
  }
}

export async function whoamiRoutes(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/whoami',
    {
      schema: {
        response: {
          200: z.object({
            userId: z.string(),
            teamId: z.string().nullable(),
            // Human-readable profile fields (P1) — the dashboard and MCP display these
            // alongside the DB-backed user/team ids.
            teamName: z.string().nullable(),
            userDisplayName: z.string().nullable(),
            userEmail: z.string().nullable(),
            adminLevel: z.enum(['none', 'admin', 'superuser']),
            isTeamMember: z.boolean(),
            isTeamAdmin: z.boolean(),
            isGlobalSuperuser: z.boolean(),
            // Teams this team has MOUNTED — the MCP's cross-team "additional" reads.
            mountedTeams: z.array(z.string()),
            // Deploy-time topology (Phase 13) — lets the dashboard label local mode.
            deploymentMode: z.enum(['server', 'local']),
          }),
        },
      },
    },
    async (req) => {
      // identity is guaranteed by the secured-scope auth hook (token OR local).
      const id = req.identity!
      // Human profile fields are control-table reads (outside RLS) → ownerPrisma.
      const profile = await readWhoamiProfile(id)
      return {
        userId: id.userId,
        teamId: id.teamId,
        ...profile,
        adminLevel: id.adminLevel,
        isTeamMember: id.isTeamMember,
        isTeamAdmin: id.isTeamAdmin,
        isGlobalSuperuser: id.isGlobalSuperuser,
        mountedTeams: id.mountedTeamIds,
        deploymentMode: config.DEPLOYMENT_MODE,
      }
    },
  )
}
