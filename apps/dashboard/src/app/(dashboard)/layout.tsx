import { requireSession } from '@/lib/session'
import { isLocalMode } from '@/lib/deploymentMode'
import { api, configuredMemorySurfaces } from '@/lib/api'
import { Nav } from '@/components/Nav'
import { AppHeader } from '@/components/AppHeader'
import { ToastProvider } from '@/components/ui/Toast'
import type { Profile } from '@/lib/types'

/**
 * Dashboard route-group layout. requireSession() runs on EVERY nested page,
 * re-validating identity (token in server mode; the optional password soft-lock in
 * local mode). The live identity + the self-service profile flow into Nav (profile
 * area + role-gated links) and AppHeader (team + role badges, logout/lock).
 * ToastProvider wraps the tree so any screen can raise toasts.
 */
function deriveRole(who: {
  adminLevel: string
  isGlobalSuperuser: boolean
  isTeamAdmin: boolean
}): { label: string; cls: 'super' | 'admin' | 'member' } {
  if (who.isGlobalSuperuser || who.adminLevel === 'superuser') return { label: 'Super Admin', cls: 'super' }
  if (who.isTeamAdmin || who.adminLevel === 'admin') return { label: 'Team Admin', cls: 'admin' }
  return { label: 'Member', cls: 'member' }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const who = await requireSession()
  const role = deriveRole(who)

  // Self-service profile for the nav identity/name (best-effort — fall back to whoami).
  const profile: Profile = await api.getProfile().catch(() => ({
    userId: who.userId,
    displayName: null,
    email: null,
    adminLevel: who.adminLevel,
    teamId: who.teamId,
    teamName: who.teamName ?? null,
    hasPassword: false,
    passwordTemporary: false,
  }))

  const teamName = who.teamId
    ? who.teamName || profile.teamName || `team ${who.teamId.slice(0, 8)}…`
    : null
  // Show the logout/lock control in server mode always; in local mode only when a
  // password is set (otherwise there is no session to end).
  const localPwSet = isLocalMode ? (await api.localAuthStatus().catch(() => ({ passwordSet: false }))).passwordSet : false
  const memorySurfaces = await configuredMemorySurfaces()
  const sharedConnection = isLocalMode ? await api.getSharedConnection().catch(() => null) : null

  return (
    <ToastProvider>
      <div className="shell">
        <Nav
          adminLevel={who.adminLevel}
          roleLabel={role.label}
          roleClass={role.cls}
          profile={profile}
          localMode={isLocalMode}
          memorySurfaces={memorySurfaces}
          sharedConnection={sharedConnection}
        />
        <div className="app-main">
          <AppHeader
            teamName={teamName}
            roleLabel={role.label}
            roleClass={role.cls}
            showLogout={!isLocalMode || localPwSet}
            localMode={isLocalMode}
            canStartUpdate={who.adminLevel === 'superuser' || who.isGlobalSuperuser}
            passwordTemporary={profile.passwordTemporary}
          />
          <main className="content">{children}</main>
        </div>
      </div>
    </ToastProvider>
  )
}
