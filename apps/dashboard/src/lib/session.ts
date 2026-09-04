import 'server-only'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { api, whoamiWithToken } from './api'
import { canAccessControlPlane, canAccessServerDashboard, isSuperuserLevel } from './authz'
import { isLocalMode } from './deploymentMode'
import { hasValidLocalSession } from './local-session'
import { SESSION_COOKIE } from './cookies'
import type { WhoAmI } from './types'

// Re-export so existing importers (api.ts, route handlers, actions) keep working.
export { SESSION_COOKIE }

/** Fallback local super-user shape (used only if the api /whoami is unreachable;
 * normally we fetch the live DB identity so teamName/displayName are real). */
const LOCAL_WHOAMI: WhoAmI = {
  userId: 'local-api-unavailable',
  teamId: null,
  teamName: null,
  adminLevel: 'superuser',
  isTeamMember: true,
  isTeamAdmin: false,
  isGlobalSuperuser: true,
  deploymentMode: 'local',
}

/**
 * persistent-memory-dashboard — session helpers (server-only).
 *
 * The session is a single httpOnly cookie holding either a signed dashboard
 * session token (normal server-mode email/password login) or a raw PM wire token
 * for recovery login. The credential never reaches client JS (httpOnly) and never
 * leaves the server side (the api client attaches it server-side per request).
 *
 * The authoritative gate is requireSession(): it re-validates the token against
 * /whoami on every dashboard navigation, so a revoked/expired token (or one
 * demoted to adminLevel='none') is caught immediately — the cookie's mere
 * presence is necessary but not sufficient.
 */

const MAX_AGE_SECONDS = 60 * 60 * 8 // 8h working session

/** Set the session cookie. Called only from loginAction after /whoami passes. */
export async function setSession(token: string): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearSession(): Promise<void> {
  ;(await cookies()).delete(SESSION_COOKIE)
}

export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value
}

/**
 * Gate every dashboard page/layout. Re-validates the cookie's token against
 * /whoami; redirects to /login if the cookie is missing or the token is invalid/
 * revoked/expired. ANY valid token is admitted (the dashboard is now the "Web QA
 * Management App" — a team member can manage memories; control-plane pages gate
 * separately via requireControlPlane). Returns the live identity so pages can
 * role-gate their controls.
 */
export async function requireSession(): Promise<WhoAmI> {
  // Local mode (Phase 13 + P1): the api accepts no-auth and injects the single
  // super-user. The OPTIONAL dashboard password (P1) is a UI soft lock enforced HERE:
  // if a password is set we require a valid signed local-session cookie, else bounce to
  // /login. We fetch the live identity (no token needed in local mode) so teamName +
  // role are real; LOCAL_WHOAMI is only a fallback if the api is unreachable.
  if (isLocalMode) {
    const status = await api.localAuthStatus().catch(() => ({ passwordSet: false }))
    if (status.passwordSet && !(await hasValidLocalSession())) redirect('/login')
    return await api.whoami().catch(() => LOCAL_WHOAMI)
  }

  const token = await getSessionToken()
  if (!token) redirect('/login')

  let who: WhoAmI | null
  try {
    who = await whoamiWithToken(token)
  } catch {
    // Network/api error talking to the API → treat as logged out.
    redirect('/login')
  }
  if (!who) {
    // Revoked/expired token → clear the stale cookie and bounce to /login.
    await clearSession()
    redirect('/login')
  }
  if (!canAccessServerDashboard(who.adminLevel, who.deploymentMode ?? 'server')) {
    await clearSession()
    redirect('/login')
  }
  return who
}

/**
 * Gate a CONTROL-plane page (Teams/Users/Tokens/Settings). Admits admin/superuser
 * only; a plain member is redirected to the Memories page (their landing). The api
 * is the authoritative gate; this is UX + defence-in-depth.
 */
export async function requireControlPlane(): Promise<WhoAmI> {
  const who = await requireSession()
  if (!canAccessControlPlane(who.adminLevel)) redirect('/memories')
  return who
}

/** True iff the live session is a superuser (gates admin_level + settings UI). */
export function isSuperuser(who: WhoAmI): boolean {
  return isSuperuserLevel(who.adminLevel)
}
