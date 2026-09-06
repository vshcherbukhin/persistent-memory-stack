import { requireSession, isSuperuser } from '@/lib/session'
import { canAccessControlPlane } from '@/lib/authz'
import { api, normalizeMemorySurface } from '@/lib/api'
import { MemoriesClient } from './MemoriesClient'
import type { Memory, Team, PendingEmbeddings } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Memories — open to ANY team member. Reads are universal (search any team).
 * A plain member edits/deletes only their own; an admin manages their team (or
 * any team, for a super-admin) and gets export / import.
 */
export default async function MemoriesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  const surface = normalizeMemorySurface(Array.isArray(params.surface) ? params.surface[0] : params.surface)
  const localWho = await requireSession()
  let surfaceAvailable = true
  let who = localWho
  if (surface === 'shared') {
    try {
      who = await api.memoryWhoami(surface)
    } catch {
      surfaceAvailable = false
    }
  }
  const isAdmin = surfaceAvailable && canAccessControlPlane(who.adminLevel)

  let initial: Memory[] = []
  let initialTotal = 0
  let initialNextCursor: string | null = null
  let initialBadges: string[] = []
  let teams: Team[] = []
  let users: { id: string; label: string }[] = []
  let pending: PendingEmbeddings | null = null
  // Projects (with their team) back the search project-filter + the team-scoped
  // bulk-delete project dropdown. One fetch; derive distinct names for the search.
  const projectScopes = surfaceAvailable ? await api.listProjectScopes(surface).catch(() => [] as { name: string; teamId: string }[]) : []
  const projects = [...new Set(projectScopes.map((p) => p.name))]

  if (!surfaceAvailable) {
    initial = []
    initialTotal = 0
  } else if (isAdmin) {
    const [list, t, p, u] = await Promise.all([
      api.listMemories({ limit: 50 }, surface),
      api.listTeams(surface),
      api.pendingEmbeddings(surface).catch(() => null),
      api.listUsers(surface).catch(() => []),
    ])
    initial = list.results
    initialTotal = list.total
    initialNextCursor = list.nextCursor
    initialBadges = list.badges
    teams = t
    pending = p
    // Authors for the export user-filter (label = name → email → short id).
    users = u.map((x) => ({ id: x.id, label: x.displayName || x.email || `${x.id.slice(0, 8)}…` }))
  } else {
    const list = await api.dpListMemories({ limit: 50 }, surface)
    initial = list.results
    initialTotal = list.total
    initialNextCursor = list.nextCursor
    initialBadges = list.badges
  }

  return (
    <MemoriesClient
      who={who}
      surface={surface}
      isAdmin={isAdmin}
      canRunBackfill={surface === 'personal' && isSuperuser(who)}
      graphEnabled={process.env.PM_MEMORY_GRAPH_UI_ENABLED !== 'false'}
      initial={initial}
      initialTotal={initialTotal}
      initialNextCursor={initialNextCursor}
      initialBadges={initialBadges}
      teams={teams}
      users={users}
      projects={projects}
      projectScopes={projectScopes}
      initialPending={pending}
    />
  )
}
