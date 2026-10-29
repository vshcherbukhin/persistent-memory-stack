import { api, ApiError, ForbiddenError, UnauthorizedError } from '@/lib/api'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  await requireSession()
  try {
    return Response.json(await api.memoryActivity(request.signal), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (error instanceof ForbiddenError) return Response.json({ error: 'forbidden' }, { status: 403 })
    if (error instanceof ApiError) return Response.json({ error: error.code }, { status: error.status })
    return Response.json({ error: 'memory_activity_unavailable' }, { status: 503 })
  }
}
