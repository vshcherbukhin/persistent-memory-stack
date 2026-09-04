'use server'

import { redirect } from 'next/navigation'
import { api, whoamiWithToken, ApiError } from '@/lib/api'
import { setSession, clearSession } from '@/lib/session'
import { setLocalSession, clearLocalSession } from '@/lib/local-session'
import { isLocalMode } from '@/lib/deploymentMode'
import { canAccessServerDashboard } from '@/lib/authz'

export interface LoginState {
  error?: string
}

/**
 * loginAction:
 *  • SERVER password: email/password -> dashboard session token; MCP/API tokens are
 *    not the normal human login credential.
 *  • SERVER recovery: a PM token validated through /whoami; break-glass for SSO or
 *    forgotten passwords. Control-plane pages still gate by role.
 *  • LOCAL: optional dashboard password soft lock.
 *
 * redirect() throws a control-flow signal → MUST be OUTSIDE try/catch.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (isLocalMode) {
    const password = String(formData.get('password') ?? '')
    if (!password) return { error: 'Enter your dashboard password.' }
    let r: { ok: boolean }
    try {
      r = await api.localLogin(password)
    } catch {
      return { error: 'Could not reach the API. Try again.' }
    }
    if (!r.ok) return { error: 'Incorrect password.' }
    await setLocalSession()
    redirect('/')
  }

  const authMode = String(formData.get('authMode') ?? 'password')
  if (authMode === 'recovery-token') {
    const token = String(formData.get('token') ?? '').trim()
    if (!token) return { error: 'Paste your recovery token.' }
    let who
    try {
      who = await whoamiWithToken(token)
    } catch {
      return { error: 'Could not reach the API. Try again.' }
    }
    if (!who) return { error: 'Invalid or revoked recovery token.' }
    if (!canAccessServerDashboard(who.adminLevel, who.deploymentMode ?? 'server')) {
      return { error: 'The shared server dashboard is super-admin only. Use your local dashboard to manage Shared Memories.' }
    }

    await setSession(token)
    redirect('/')
  }

  if (authMode === 'sso') {
    return { error: 'SSO provider login is not configured yet. Use recovery token if you need access now.' }
  }

  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  if (!email || !password) return { error: 'Enter your email and password.' }
  let login
  try {
    login = await api.passwordLogin(email, password)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'sso_login_enabled') {
      return { error: 'SSO is enabled for this server. Use the SSO card or recovery token.' }
    }
    return { error: 'Invalid email or password.' }
  }

  const who = await whoamiWithToken(login.sessionToken).catch(() => null)
  if (!who) return { error: 'Could not verify the dashboard session. Try again.' }
  if (!canAccessServerDashboard(who.adminLevel, who.deploymentMode ?? 'server')) {
    return { error: 'The shared server dashboard is super-admin only. Use your local dashboard to manage Shared Memories.' }
  }
  await setSession(login.sessionToken)
  redirect('/')
}

export async function logoutAction(): Promise<void> {
  // Local mode: clear the soft-lock session → /login (which re-prompts for the password).
  if (isLocalMode) {
    await clearLocalSession()
    redirect('/login')
  }
  await clearSession()
  redirect('/login')
}
