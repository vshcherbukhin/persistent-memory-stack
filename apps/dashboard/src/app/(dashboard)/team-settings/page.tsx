import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/session'
import { isLocalMode } from '@/lib/deploymentMode'
import { api } from '@/lib/api'
import { TeamSettings } from './TeamSettings'

export const dynamic = 'force-dynamic'

/** Local-only single-team settings (P1). Server installs manage teams/users on the
 * dedicated multi-tenant pages instead. */
export default async function TeamSettingsPage() {
  if (!isLocalMode) redirect('/')
  const who = await requireSession()
  const [profile, users] = await Promise.all([api.getProfile().catch(() => null), api.listUsers().catch(() => [])])
  const teamName = who.teamName ?? profile?.teamName ?? ''
  const rows = users.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    role: u.adminLevel === 'superuser' ? 'Super Admin' : u.adminLevel === 'admin' ? 'Team Admin' : 'Member',
    createdAt: u.createdAt,
  }))
  return <TeamSettings teamId={who.teamId ?? ''} teamName={teamName} users={rows} />
}
