/**
 * Identity & scope tools: whoami, list_readable_teams, list_projects.
 *
 * Access model: docs/internal/users_roles.md. Reads are UNIVERSAL (any team
 * member searches any team); writes are current-team + per-author bounded. A
 * team-less caller is rejected by the data plane entirely (the MCP requires a
 * team) — a team-less super-admin manages memories on the dashboard, not here.
 */
import { z } from 'zod'
import { ApiError } from '../errors.ts'
import { ok, fromApiError, RO_ANNOTATIONS } from '../schemas.ts'
import type { RegisterFn } from './context.ts'

interface WhoamiResponse {
  userId: string
  teamId: string | null
  teamName: string | null
  userDisplayName: string | null
  userEmail: string | null
  adminLevel: 'none' | 'admin' | 'superuser'
  isTeamMember: boolean
  isTeamAdmin: boolean
  isGlobalSuperuser: boolean
  mountedTeams: string[]
  deploymentMode: 'server' | 'local'
}

/** Human-readable write capability for the current identity (MCP/data-plane rules). */
function writeCapability(r: WhoamiResponse): string {
  if (r.deploymentMode === 'local') return 'personal memories in this local stack'
  if (!r.isTeamMember) return 'NONE via the MCP (you are team-less — manage memories on the dashboard)'
  if (r.isTeamAdmin || r.isGlobalSuperuser) return 'any memory in your current team'
  return 'memories you create, in your current team'
}

function userLabel(r: WhoamiResponse): string {
  const name = r.userDisplayName?.trim()
  const email = r.userEmail?.trim()
  if (name && email) return `${name} <${email}> (${r.userId})`
  if (name) return `${name} (${r.userId})`
  if (email) return `${email} (${r.userId})`
  return r.userId
}

function teamLabel(r: WhoamiResponse): string {
  if (r.deploymentMode === 'local') return 'Personal memories'
  if (!r.teamId) return '(none — global super-admin)'
  return r.teamName ? `${r.teamName} (${r.teamId})` : r.teamId
}

function memoryScopeLabel(r: WhoamiResponse): string {
  if (r.deploymentMode === 'local') return 'Memory search = personal memories in this local stack.'
  return `Memory search = your team (primary) ∪ ${r.mountedTeams.length} mounted team(s) (additional).`
}

export const registerIdentityTools: RegisterFn = (server, { api }) => {
  // ── whoami ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'whoami',
    {
      title: 'Show my identity & capability',
      description:
        'Return your server-DERIVED identity: user, team (null if you are a team-less global ' +
        'super-admin), adminLevel, and mountedTeams. MEMORY search = your team (primary) ∪ mounted ' +
        'teams (additional); documents/graph are universally shared. Writes are current-team + ' +
        'ownership bounded (call this to learn your write capability). A team-less caller cannot ' +
        'use the MCP at all.',
      inputSchema: {},
      outputSchema: {
        userId: z.string(),
        teamId: z.string().nullable(),
        teamName: z.string().nullable(),
        userDisplayName: z.string().nullable(),
        userEmail: z.string().nullable(),
        adminLevel: z.enum(['none', 'admin', 'superuser']),
        isTeamMember: z.boolean(),
        isTeamAdmin: z.boolean(),
        isGlobalSuperuser: z.boolean(),
        mountedTeams: z.array(z.string()),
        deploymentMode: z.enum(['server', 'local']),
      },
      annotations: RO_ANNOTATIONS,
    },
    async () => {
      try {
        const r = await api.get<WhoamiResponse>('/whoami')
        // Build the structured payload explicitly from the declared fields — never pass the api
        // response wholesale into structuredContent, or a new server field (e.g. P13's
        // deploymentMode) trips the SDK's additionalProperties:false validation.
        return ok(
          `You are ${userLabel(r)} on team ${teamLabel(r)} ` +
            `(admin_level=${r.adminLevel}, deployment=${r.deploymentMode}). ${memoryScopeLabel(r)} ` +
            `Write capability: ${writeCapability(r)}.`,
          {
            userId: r.userId,
            teamId: r.teamId,
            teamName: r.teamName,
            userDisplayName: r.userDisplayName,
            userEmail: r.userEmail,
            adminLevel: r.adminLevel,
            isTeamMember: r.isTeamMember,
            isTeamAdmin: r.isTeamAdmin,
            isGlobalSuperuser: r.isGlobalSuperuser,
            mountedTeams: r.mountedTeams,
            deploymentMode: r.deploymentMode,
          },
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── list_readable_teams ──────────────────────────────────────────────────────
  server.registerTool(
    'list_readable_teams',
    {
      title: 'What memory can I read?',
      description:
        'MEMORY reads = your own team (primary) ∪ the teams it has MOUNTED (additional). Returns your ' +
        'own team (the write target) + the mounted team ids. (Documents/graph are universally shared, ' +
        'separately.) Mounts are managed by an admin in the dashboard.',
      inputSchema: {},
      outputSchema: {
        ownTeam: z.string().nullable(),
        mountedTeams: z.array(z.string()),
      },
      annotations: RO_ANNOTATIONS,
    },
    async () => {
      try {
        const r = await api.get<WhoamiResponse>('/whoami')
        return ok(
          r.deploymentMode === 'local'
            ? 'Memory: personal memories in this local stack. No Shared Memories team is implied.'
            : `Memory: your team = ${teamLabel(r)} (primary) + ${r.mountedTeams.length} mounted team(s) (additional).`,
          { ownTeam: r.teamId, mountedTeams: r.mountedTeams },
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── list_projects (GET /projects) ─────────────────────────────────────────────
  const ProjectsResponse = {
    projects: z.array(
      z.object({
        name: z.string(),
        memoryCount: z.number(),
        documentCount: z.number(),
        sourceTeam: z.string(),
        isOwnTeam: z.boolean(),
      }),
    ),
    counts: z.object({ own: z.number(), other: z.number() }),
  }

  server.registerTool(
    'list_projects',
    {
      title: 'List known projects',
      description:
        'List the distinct projects that exist across all teams (reads are universal), with ' +
        'per-project memory/document counts (own-team projects first). Call BEFORE a write to pick ' +
        'the correct `project` value — reuse an existing project name instead of inventing a ' +
        'near-duplicate. Supports the project nudge.',
      inputSchema: {
        scope: z
          .union([z.enum(['own', 'granted']), z.array(z.string())])
          .optional()
          .describe('Optional read scope (own | granted = other teams | explicit team ids). e.g. "own"'),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(500)
          .describe('Max distinct projects to return. e.g. 200'),
      },
      outputSchema: ProjectsResponse,
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const r = await api.get<{
          projects: z.infer<typeof ProjectsResponse.projects>
          counts: { own: number; other: number }
        }>('/projects', { scope: input.scope, limit: input.limit })
        return ok(
          `${r.projects.length} project(s) across all teams (own=${r.counts.own}, other=${r.counts.other}).`,
          r as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )
}
