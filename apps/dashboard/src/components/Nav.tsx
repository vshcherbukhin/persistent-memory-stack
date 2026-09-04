'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isSuperuserLevel, canAccessControlPlane } from '@/lib/authz'
import { Avatar } from './ui/Avatar'
import { ProductMark } from './ui/ProductMark'
import { ProfileModal } from './ProfileModal'
import { Select } from './ui/Select'
import { Icon, type IconName } from './ui/Icon'
import { Tooltip } from './ui/Tooltip'
import type { AdminLevel, Profile, SharedConnectionStatus } from '@/lib/types'
import { mergeNavigationHealth, securityAlertIndicator, servicesAttention, workersAttention, type NavigationHealth } from '@/lib/navigation-attention'

type MemorySurface = 'personal' | 'shared'
type DashboardSpace = 'personal' | 'shared'
type NavLinkItem = {
  href: string
  label: string
  icon: IconName
  controlPlane?: boolean
  superuserOnly?: boolean
}

const EMPTY_NAVIGATION_HEALTH: NavigationHealth = {
  securityOpen: 0,
  servicesDown: 0,
  workersDown: 0,
}

/**
 * Sidebar nav. The local dashboard has two first-class spaces: personal memories
 * and shared memories. Personal owns the local stack. Shared starts with only
 * Connection, then exposes server-backed pages according to the connector role.
 * The bottom-left is the user PROFILE area (P1): initials + name. Role, logout,
 * and release notes live in the top bar.
 */
const PERSONAL_LINKS: NavLinkItem[] = [
  { href: '/', label: 'Overview', icon: 'dashboard', controlPlane: true },
  { href: '/memories?surface=personal', label: 'Memories', icon: 'memory' },
  { href: '/services', label: 'Services', icon: 'dns' },
  { href: '/workers', label: 'Workers', icon: 'work_history' },
  { href: '/usage', label: 'Token usage', icon: 'query_stats' },
  { href: '/security', label: 'Security', icon: 'security', controlPlane: true },
  { href: '/notifications', label: 'Notifications', icon: 'notifications', controlPlane: true },
  { href: '/settings', label: 'System Settings', icon: 'settings', superuserOnly: true },
]

const SHARED_LINKS: typeof PERSONAL_LINKS = [
  { href: '/connection', label: 'Connection', icon: 'cloud_sync' },
  { href: '/', label: 'Overview', icon: 'dashboard', controlPlane: true },
  { href: '/memories?surface=shared', label: 'Memories', icon: 'memory' },
  { href: '/usage', label: 'Token usage', icon: 'query_stats', controlPlane: true },
  { href: '/security', label: 'Security', icon: 'security', controlPlane: true },
  { href: '/notifications', label: 'Notifications', icon: 'notifications', controlPlane: true },
]

const SERVER_LINKS: typeof PERSONAL_LINKS = [
  { href: '/', label: 'Overview', icon: 'dashboard', controlPlane: true },
  { href: '/memories?surface=shared', label: 'Memories', icon: 'memory' },
  { href: '/services', label: 'Services', icon: 'dns' },
  { href: '/workers', label: 'Workers', icon: 'work_history' },
  { href: '/usage', label: 'Token usage', icon: 'query_stats' },
  { href: '/security', label: 'Security', icon: 'security', controlPlane: true },
  { href: '/notifications', label: 'Notifications', icon: 'notifications', controlPlane: true },
  { href: '/teams', label: 'Teams', icon: 'groups', controlPlane: true },
  { href: '/users', label: 'Users', icon: 'person', controlPlane: true },
  { href: '/tokens', label: 'Tokens', icon: 'key', superuserOnly: true },
  { href: '/grants', label: 'Mounts', icon: 'hub', controlPlane: true },
  { href: '/settings', label: 'System Settings', icon: 'settings', superuserOnly: true },
]

function withSpace(href: string, space: DashboardSpace): string {
  const [path, rawQuery = ''] = href.split('?')
  const params = new URLSearchParams(rawQuery)
  params.set('space', space)
  return `${path}?${params.toString()}`
}

function activeFor(pathname: string, searchParams: URLSearchParams, href: string, space: DashboardSpace): boolean {
  const [path, rawQuery = ''] = href.split('?')
  if (path === '/' ? pathname !== '/' : !pathname.startsWith(path)) return false
  const params = new URLSearchParams(rawQuery)
  const surface = params.get('surface')
  if (surface && searchParams.get('surface') !== surface) return false
  return (searchParams.get('space') ?? (searchParams.get('surface') === 'shared' || pathname.startsWith('/connection') ? 'shared' : 'personal')) === space
}

export function Nav({
  adminLevel,
  roleLabel,
  roleClass,
  profile,
  localMode = false,
  memorySurfaces = ['shared'],
  sharedConnection = null,
}: {
  adminLevel: AdminLevel
  roleLabel: string
  roleClass: 'super' | 'admin' | 'member'
  profile: Profile
  localMode?: boolean
  memorySurfaces?: MemorySurface[]
  sharedConnection?: SharedConnectionStatus | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    const openProfile = () => setProfileOpen(true)
    window.addEventListener('pm:open-profile', openProfile)
    return () => window.removeEventListener('pm:open-profile', openProfile)
  }, [])

  const name = profile.displayName || profile.email || `user ${profile.userId.slice(0, 8)}…`
  const requestedSpace = searchParams.get('space')
  const selectedSpace: DashboardSpace = localMode
    ? pathname.startsWith('/connection') || requestedSpace === 'shared' || searchParams.get('surface') === 'shared'
      ? 'shared'
      : 'personal'
    : memorySurfaces[0] === 'personal'
      ? 'personal'
      : 'shared'
  const sharedLevel = sharedConnection?.remoteIdentity?.adminLevel ?? 'none'
  const gateLevel = selectedSpace === 'shared' && localMode ? sharedLevel : adminLevel
  const isSuperuser = isSuperuserLevel(gateLevel)
  const isAdmin = canAccessControlPlane(gateLevel)
  const links: NavLinkItem[] = !localMode
    ? SERVER_LINKS
    : selectedSpace === 'shared'
      ? sharedConnection?.configured
        ? SHARED_LINKS
        : [{ href: '/connection', label: 'Connection', icon: 'cloud_sync' }]
      : PERSONAL_LINKS
  const watchesRuntime = links.some((link) => link.href === '/services' || link.href === '/workers')
  const [navigationHealth, setNavigationHealth] = useState<NavigationHealth>(EMPTY_NAVIGATION_HEALTH)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(
          `/api/navigation-health?space=${selectedSpace}&runtime=${watchesRuntime ? '1' : '0'}&security=${isAdmin ? '1' : '0'}`,
          { cache: 'no-store' },
        )
        if (!response.ok) return
        const data = await response.json() as Partial<NavigationHealth>
        if (!cancelled) {
          setNavigationHealth((current) => mergeNavigationHealth(current, data))
        }
      } catch {
        // A navigation signal must never make the sidebar unusable when the API is temporarily unavailable.
      }
    }
    const refresh = () => void load()
    void load()
    window.addEventListener('pm:navigation-attention-changed', refresh)
    const interval = window.setInterval(refresh, 15_000)
    return () => {
      cancelled = true
      window.removeEventListener('pm:navigation-attention-changed', refresh)
      window.clearInterval(interval)
    }
  }, [isAdmin, selectedSpace, watchesRuntime])

  const changeSpace = (value: string) => {
    const next = value === 'shared' ? 'shared' : 'personal'
    if (next === 'personal') {
      router.push(withSpace('/', 'personal'))
      return
    }
    router.push(withSpace(sharedConnection?.configured ? '/memories?surface=shared' : '/connection', 'shared'))
  }

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <ProductMark />
        </span>
        <span>PM Management<small>Persistent Memory</small></span>
      </div>
      {localMode ? (
        <div className="space-switch">
          <span className="space-switch-label">Switch Space</span>
          <Select
            ariaLabel="Switch dashboard space"
            value={selectedSpace}
            onChange={changeSpace}
            options={[
              { value: 'personal', label: 'Personal memories' },
              { value: 'shared', label: 'Shared memories' },
            ]}
          />
        </div>
      ) : null}
      <div className="nav-list">
        {links.filter(
          (l) =>
            (!l.superuserOnly || isSuperuser) &&
            (!l.controlPlane || isAdmin),
        ).map((l) => {
          const active = activeFor(pathname, searchParams, l.href, selectedSpace)
          const attention = l.href === '/security'
            ? securityAlertIndicator(navigationHealth.securityOpen)
            : l.href === '/services'
              ? servicesAttention(navigationHealth.servicesDown)
              : l.href === '/workers'
                ? workersAttention(navigationHealth.workersDown)
                : { visible: false as const }
          return (
            <span key={`${selectedSpace}:${l.href}`} style={{ display: 'contents' }}>
              <Link href={withSpace(l.href, selectedSpace)} className={`navlink${active ? ' active' : ''}`}>
                <Icon name={l.icon} size={18} className="nav-icon" />
                <span>{l.label}</span>
                {l.superuserOnly && selectedSpace === 'shared' ? (
                  <>
                    <span className="nav-grow" />
                    <span className="nav-super">super</span>
                  </>
                ) : null}
                {attention.visible ? (
                  <>
                    <span className="nav-grow" />
                    <span className="nav-attention-marker" role="status" aria-label={attention.label} title={attention.label}>!</span>
                  </>
                ) : null}
              </Link>
            </span>
          )
        })}
      </div>
      <div className="nav-documentation">
        <Link
          href={withSpace('/documentation', selectedSpace)}
          className={`navlink${pathname.startsWith('/documentation') ? ' active' : ''}`}
        >
          <Icon name="menu_book" size={18} className="nav-icon" />
          <span>Documentation</span>
        </Link>
      </div>
      <div className="who">
        <Tooltip label="Your profile" className="profile-tooltip">
          <button type="button" className="profile-btn" onClick={() => setProfileOpen(true)}>
            <Avatar name={name} email={profile.email ?? undefined} size={34} />
            <span className="profile-name">{name}</span>
          </button>
        </Tooltip>
      </div>
      {profileOpen ? (
        <ProfileModal profile={profile} localMode={localMode} roleLabel={roleLabel} roleClass={roleClass} onClose={() => setProfileOpen(false)} />
      ) : null}
    </nav>
  )
}
