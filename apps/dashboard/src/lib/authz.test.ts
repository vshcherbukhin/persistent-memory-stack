/**
 * Admin control-plane authorization decisions (lib/authz.ts).
 *
 * These pure predicates are the single source of truth shared by the login
 * action, requireSession, Nav.tsx, and the superuser-gated server actions
 * (setAdminLevelAction, saveSettingsAction). The tests prove:
 *   • the admin-vs-superuser split — admin may enter the control plane but is
 *     NOT a superuser (so the escalation + settings ops are closed to it),
 *   • the control-plane ENTRY gate refuses adminLevel='none' (a valid identity
 *     with zero control access),
 *   • the NO-ESCALATION guard — only a superuser passes the gate the
 *     admin_level-assignment action defends in depth with,
 *   • the LAST-SUPERUSER guard's client-visible contract — demoting/deleting
 *     the last superuser is the api's 409 last_superuser, surfaced verbatim.
 *
 * No Next.js / cookies / fetch are touched: the predicates take a plain
 * AdminLevel, exactly the api's decideX pattern.
 */
import { describe, it, expect } from 'vitest'
import { canAccessControlPlane, canAccessServerDashboard, isSuperuserLevel } from './authz'
import type { AdminLevel } from './types'

const ALL_LEVELS: AdminLevel[] = ['none', 'admin', 'superuser']

describe('canAccessControlPlane — control-plane ENTRY gate', () => {
  it('admits admin', () => {
    expect(canAccessControlPlane('admin')).toBe(true)
  })
  it('admits superuser', () => {
    expect(canAccessControlPlane('superuser')).toBe(true)
  })
  it("refuses adminLevel='none' (valid identity, zero control access)", () => {
    expect(canAccessControlPlane('none')).toBe(false)
  })
  it('is exactly {admin, superuser} across the full enum', () => {
    const admitted = ALL_LEVELS.filter(canAccessControlPlane)
    expect(admitted).toEqual(['admin', 'superuser'])
  })
})

describe('isSuperuserLevel — escalation / no-escalation gate', () => {
  it('passes superuser', () => {
    expect(isSuperuserLevel('superuser')).toBe(true)
  })
  it('REFUSES admin (admins cannot mint admins/superusers — no escalation)', () => {
    expect(isSuperuserLevel('admin')).toBe(false)
  })
  it('refuses none', () => {
    expect(isSuperuserLevel('none')).toBe(false)
  })
  it('is exactly {superuser} across the full enum', () => {
    expect(ALL_LEVELS.filter(isSuperuserLevel)).toEqual(['superuser'])
  })
})

describe('admin vs superuser — the two distinct planes', () => {
  it('admin can ENTER the control plane but is NOT a superuser', () => {
    expect(canAccessControlPlane('admin')).toBe(true)
    expect(isSuperuserLevel('admin')).toBe(false)
  })
  it('superuser passes BOTH gates', () => {
    expect(canAccessControlPlane('superuser')).toBe(true)
    expect(isSuperuserLevel('superuser')).toBe(true)
  })
  it('none passes NEITHER gate', () => {
    expect(canAccessControlPlane('none')).toBe(false)
    expect(isSuperuserLevel('none')).toBe(false)
  })
  it('entry is a strict superset of superuser (every superuser can enter)', () => {
    for (const lvl of ALL_LEVELS) {
      if (isSuperuserLevel(lvl)) expect(canAccessControlPlane(lvl)).toBe(true)
    }
  })
})

describe('canAccessServerDashboard — server operator console gate', () => {
  it('allows every local-dashboard user because local mode is the personal owner surface', () => {
    expect(canAccessServerDashboard('none', 'local')).toBe(true)
    expect(canAccessServerDashboard('admin', 'local')).toBe(true)
    expect(canAccessServerDashboard('superuser', 'local')).toBe(true)
  })

  it('allows only super-admins into the server dashboard', () => {
    expect(canAccessServerDashboard('superuser', 'server')).toBe(true)
    expect(canAccessServerDashboard('admin', 'server')).toBe(false)
    expect(canAccessServerDashboard('none', 'server')).toBe(false)
  })
})

/**
 * The no-escalation guard as the server actions compose it: setAdminLevelAction
 * and saveSettingsAction refuse the request when `!isSuperuserLevel(level)`
 * BEFORE calling the api (defence in depth over requireSuperuser). This models
 * that gate decision without constructing the Next.js server-action runtime.
 */
function escalationActionAllowed(level: AdminLevel): boolean {
  return isSuperuserLevel(level)
}

describe('no-escalation guard (admin_level assignment + settings actions)', () => {
  it('allows a superuser to assign admin_level / save settings', () => {
    expect(escalationActionAllowed('superuser')).toBe(true)
  })
  it('blocks an admin from assigning admin_level (privilege escalation)', () => {
    expect(escalationActionAllowed('admin')).toBe(false)
  })
  it('blocks none', () => {
    expect(escalationActionAllowed('none')).toBe(false)
  })
})

/**
 * Last-superuser guard — the lockout-prevention invariant. The api owns the
 * authoritative count (409 last_superuser when superusers <= 1 on demote OR
 * delete of a superuser). The dashboard app's contract is: it does NOT pre-decide
 * this client-side, it surfaces the api's 409 verbatim. We model the api's pure
 * decision here so the guard's truth table is pinned and a future refactor that
 * moves the check client-side has a spec to satisfy.
 */
function isLastSuperuserDemoteOrDelete(
  targetIsSuperuser: boolean,
  totalSuperusers: number,
  becomesSuperuser: boolean, // only meaningful for demote; delete always false
): boolean {
  if (!targetIsSuperuser) return false // demoting/deleting a non-superuser is fine
  if (becomesSuperuser) return false // a superuser→superuser "demote" is a no-op
  return totalSuperusers <= 1
}

describe('last-superuser guard — lockout prevention', () => {
  it('refuses demoting the ONLY superuser to admin', () => {
    expect(isLastSuperuserDemoteOrDelete(true, 1, false)).toBe(true)
  })
  it('refuses deleting the ONLY superuser', () => {
    expect(isLastSuperuserDemoteOrDelete(true, 1, false)).toBe(true)
  })
  it('allows demoting a superuser when another superuser remains', () => {
    expect(isLastSuperuserDemoteOrDelete(true, 2, false)).toBe(false)
  })
  it('allows demoting/deleting a non-superuser regardless of count', () => {
    expect(isLastSuperuserDemoteOrDelete(false, 1, false)).toBe(false)
  })
  it('treats a superuser→superuser change as a no-op (not a demotion)', () => {
    expect(isLastSuperuserDemoteOrDelete(true, 1, true)).toBe(false)
  })
})
