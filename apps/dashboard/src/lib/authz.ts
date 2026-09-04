/**
 * persistent-memory-dashboard — pure authorization decisions (NO Next.js, NO I/O).
 *
 * The dashboard app mirrors the api's two-plane model but only sees the CONTROL
 * plane: every gate keys on adminLevel. These predicates are the single source
 * of truth for the admin-vs-superuser decisions; session.ts, the server actions,
 * the login action, and Nav.tsx all call them so the UI gate and the
 * defend-in-depth action gate can never drift from each other.
 *
 * NOTE: the api is the authoritative gate (requireAdmin / requireSuperuser on
 * every route + the last_superuser guard). These client-side checks are
 * convenience + defence-in-depth, never the sole barrier. They are pure (take a
 * plain AdminLevel, no WhoAmI / cookies / fetch) precisely so they are trivially
 * unit-testable in isolation — the same pattern as the api's decideX functions.
 */
import type { AdminLevel } from './types'

/**
 * CONTROL-plane ENTRY gate: may this admin_level enter the control plane at all?
 * adminLevel='none' is a valid identity with ZERO control access and MUST be
 * refused (login + requireSession both call this). Grants NO data access either
 * way — admin_level never widens the data plane.
 */
export function canAccessControlPlane(adminLevel: AdminLevel): boolean {
  return adminLevel === 'admin' || adminLevel === 'superuser'
}

/**
 * ESCALATION gate: may this admin_level assign admin_level / edit system
 * settings? Superuser ONLY — an admin cannot mint admins or superusers
 * (privilege-escalation / no-escalation guard). Mirrors the api's
 * requireSuperuser.
 */
export function isSuperuserLevel(adminLevel: AdminLevel): boolean {
  return adminLevel === 'superuser'
}

/**
 * SERVER dashboard gate: the hosted/shared server dashboard is an operator
 * console, so only super-admins may enter it. Local mode is the personal owner
 * dashboard and stays fully available to the local user.
 */
export function canAccessServerDashboard(
  adminLevel: AdminLevel,
  deploymentMode: 'server' | 'local',
): boolean {
  return deploymentMode === 'local' || isSuperuserLevel(adminLevel)
}
