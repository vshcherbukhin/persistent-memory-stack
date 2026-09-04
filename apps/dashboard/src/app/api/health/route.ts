/**
 * GET /api/health — liveness probe for the compose healthcheck.
 * No auth, no api call: proves the Next.js server is up. Forced dynamic so it is
 * never statically cached.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ ok: true, service: 'persistent-memory-dashboard' })
}
