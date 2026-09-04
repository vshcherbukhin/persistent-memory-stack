import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE } from './lib/cookies'
import { isLocalMode } from './lib/deploymentMode'

/**
 * Cheap PRESENCE-only auth gate. If the session cookie is absent and the request
 * targets a protected path, bounce to /login before rendering. The AUTHORITATIVE
 * validation (token still valid? still admin?) happens in the (dashboard) layout
 * via requireSession()'s /whoami re-check — middleware must not call the api
 * (Edge runtime, no secrets, keep it fast). This is purely a UX short-circuit.
 */
export function middleware(req: NextRequest) {
  // Local mode: NO auth — never bounce to /login. The (dashboard) layout's
  // requireSession() returns the DB-backed local super-user. isLocalMode is build-inlined
  // here (Edge runtime), so it's a deploy-time pin, not request-flippable.
  if (isLocalMode) return NextResponse.next()

  const hasCookie = req.cookies.has(SESSION_COOKIE)
  const { pathname } = req.nextUrl

  // /login, /api/health, and Next internals are always reachable.
  const isPublic =
    pathname === '/login' ||
    pathname.startsWith('/api/health') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')

  if (!hasCookie && !isPublic) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }
  // Already logged in but sitting on /login → send to the dashboard.
  if (hasCookie && pathname === '/login') {
    const url = req.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // Run on everything except static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
