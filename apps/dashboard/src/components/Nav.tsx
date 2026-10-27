'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isSuperuserLevel, canAccessControlPlane } from '@/lib/authz'
import { Avatar } from './ui/Avatar'
import { ProductMark } from './ui/ProductMark'
import { ProfileModal } from './ProfileModal'
import { Icon, type IconName } from './ui/Icon'
import { Tooltip } from './ui/Tooltip'
import type { AdminLevel, Profile } from '@/lib/types'
import { mergeNavigationHealth, securityAlertIndicator, servicesAttention, workersAttention, type NavigationHealth } from '@/lib/navigation-attention'

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

/** Personal knowledge and local stack navigation. */
const PERSONAL_LINKS: NavLinkItem[] = [
  { href: '/', label: 'Overview', icon: 'dashboard', controlPlane: true },
  { href: '/memories', label: 'Memories', icon: 'memory' },
  { href: '/services', label: 'Services', icon: 'dns' },
  { href: '/workers', label: 'Workers', icon: 'work_history' },
  { href: '/usage', label: 'Token usage', icon: 'query_stats' },
  { href: '/security', label: 'Security', icon: 'security', controlPlane: true },
  { href: '/notifications', label: 'Notifications', icon: 'notifications', controlPlane: true },
  { href: '/settings', label: 'System Settings', icon: 'settings', superuserOnly: true },
]

function activeFor(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href.split('?')[0]!)
}

export function Nav({
  adminLevel,
  roleLabel,
  roleClass,
  profile,
  localMode = false,
}: {
  adminLevel: AdminLevel
  roleLabel: string
  roleClass: 'super' | 'admin' | 'member'
  profile: Profile
  localMode?: boolean
}) {
  const pathname = usePathname()
  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    const openProfile = () => setProfileOpen(true)
    window.addEventListener('pm:open-profile', openProfile)
    return () => window.removeEventListener('pm:open-profile', openProfile)
  }, [])

  const name = profile.displayName || profile.email || `user ${profile.userId.slice(0, 8)}…`
  const isSuperuser = isSuperuserLevel(adminLevel)
  const isAdmin = canAccessControlPlane(adminLevel)
  const links = PERSONAL_LINKS
  const watchesRuntime = links.some((link) => link.href === '/services' || link.href === '/workers')
  const [navigationHealth, setNavigationHealth] = useState<NavigationHealth>(EMPTY_NAVIGATION_HEALTH)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(
          `/api/navigation-health?runtime=${watchesRuntime ? '1' : '0'}&security=${isAdmin ? '1' : '0'}`,
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
  }, [isAdmin, watchesRuntime])

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <ProductMark />
        </span>
        <span>Persistent Memory<small className="brand-community">Community version</small></span>
      </div>
      <div className="nav-list">
        {links.filter(
          (l) =>
            (!l.superuserOnly || isSuperuser) &&
            (!l.controlPlane || isAdmin),
        ).map((l) => {
          const active = activeFor(pathname, l.href)
          const attention = l.href === '/security'
            ? securityAlertIndicator(navigationHealth.securityOpen)
            : l.href === '/services'
              ? servicesAttention(navigationHealth.servicesDown)
              : l.href === '/workers'
                ? workersAttention(navigationHealth.workersDown)
                : { visible: false as const }
          return (
            <span key={l.href} style={{ display: 'contents' }}>
              <Link href={l.href} className={`navlink${active ? ' active' : ''}`}>
                <Icon name={l.icon} size={18} className="nav-icon" />
                <span>{l.label}</span>
                {attention.visible ? (
                  <>
                    <span className="nav-grow" />
                    <Tooltip label={attention.label}><span className="nav-attention-marker" role="status" aria-label={attention.label}>!</span></Tooltip>
                  </>
                ) : null}
              </Link>
            </span>
          )
        })}
      </div>
      <div className="nav-documentation">
        <Link
          href="/documentation"
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
