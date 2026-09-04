import { api, ApiError, ForbiddenError, UnauthorizedError } from '@/lib/api'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  try {
    return Response.json(await api.startUpdate(), { status: 202 })
  } catch (err) {
    if (err instanceof UnauthorizedError) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (err instanceof ForbiddenError) return Response.json({ error: 'forbidden' }, { status: 403 })
    if (err instanceof ApiError) return Response.json({ error: err.code, message: err.message }, { status: err.status })
    return Response.json({ error: 'update_start_failed', message: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
