import { cookies } from 'next/headers'
import { SESSION_COOKIE } from '@/lib/cookies'
import { isLocalMode } from '@/lib/deploymentMode'

/**
 * Download a memory export as a JSON file. Attaches the session token server-side
 * and streams the API's /dashboard/memories/export envelope to the browser as an
 * attachment (so the user gets a re-importable file). Optional teamId + project +
 * createdById narrow the scope. In LOCAL mode the api is no-auth, so no token is
 * required.
 */
const BASE = process.env.API_URL ?? 'http://persistent-memory-api:8090'

export async function GET(req: Request): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token && !isLocalMode) return new Response('unauthorized', { status: 401 })

  const params = new URL(req.url).searchParams
  const teamId = params.get('teamId')
  const project = params.get('project')
  const createdById = params.get('createdById')
  const qs = new URLSearchParams()
  if (teamId) qs.set('teamId', teamId)
  if (project) qs.set('project', project)
  if (createdById) qs.set('createdById', createdById)
  const query = qs.toString()

  const upstream = await fetch(`${BASE}/dashboard/memories/export${query ? `?${query}` : ''}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  const body = await upstream.text()
  if (!upstream.ok) return new Response(body, { status: upstream.status })
  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="pm-memories${teamId ? `-${teamId.slice(0, 8)}` : ''}${project ? `-${project.replace(/[^a-z0-9]+/gi, '-')}` : ''}.json"`,
    },
  })
}
