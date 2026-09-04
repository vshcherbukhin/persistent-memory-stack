import { api, ApiError, ForbiddenError, UnauthorizedError } from '@/lib/api'
import { requireControlPlane } from '@/lib/session'

export const dynamic = 'force-dynamic'

function errorResponse(err: unknown, fallback: string): Response {
  if (err instanceof UnauthorizedError) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (err instanceof ForbiddenError) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (err instanceof ApiError) return Response.json({ error: err.code, message: err.message }, { status: err.status })
  return Response.json({ error: fallback, message: err instanceof Error ? err.message : String(err) }, { status: 500 })
}

export async function GET(): Promise<Response> {
  try {
    await requireControlPlane()
    return Response.json(await api.getBrowserPushPublicKey())
  } catch (err) {
    return errorResponse(err, 'browser_push_public_key_failed')
  }
}
