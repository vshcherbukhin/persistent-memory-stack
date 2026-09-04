import 'server-only'
import { cookies } from 'next/headers'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Local-mode dashboard session (P1, full-local redesign).
 *
 * The OPTIONAL local password is a dashboard-UI SOFT LOCK (the local API/MCP stay
 * no-auth). After the api verifies the password (POST /local/auth), we mint a small
 * HMAC-signed cookie here so the gate (requireSession) admits the session without
 * re-prompting. Signed with TOKEN_PEPPER (present in the dashboard container env, never
 * shipped to the browser); if it's somehow absent the cookie degrades to a fixed
 * fallback key — still a soft lock, never a hard security boundary.
 */
const LOCAL_COOKIE = 'pm_local_session'
const MAX_AGE_SECONDS = 60 * 60 * 8 // 8h, mirrors the server-mode token session

function key(): string {
  return process.env.TOKEN_PEPPER || 'pm-local-soft-lock-fallback'
}

function sign(payload: string): string {
  return createHmac('sha256', key()).update(payload).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Mint the signed local-session cookie (called after the api confirms the password). */
export async function setLocalSession(): Promise<void> {
  const issued = String(Date.now())
  const value = `${issued}.${sign(issued)}`
  ;(await cookies()).set(LOCAL_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearLocalSession(): Promise<void> {
  ;(await cookies()).delete(LOCAL_COOKIE)
}

/** True iff a valid, unexpired, correctly-signed local-session cookie is present. */
export async function hasValidLocalSession(): Promise<boolean> {
  const v = (await cookies()).get(LOCAL_COOKIE)?.value
  if (!v) return false
  const dot = v.indexOf('.')
  if (dot <= 0) return false
  const issued = v.slice(0, dot)
  const mac = v.slice(dot + 1)
  if (!safeEqual(sign(issued), mac)) return false
  const age = Date.now() - Number(issued)
  return Number.isFinite(age) && age >= 0 && age <= MAX_AGE_SECONDS * 1000
}
