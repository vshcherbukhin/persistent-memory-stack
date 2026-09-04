import { api, ApiError, normalizeMemorySurface } from '@/lib/api'
import { requireControlPlane } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  try {
    await requireControlPlane()
    const params = new URL(req.url).searchParams
    const surface = normalizeMemorySurface(params.get('space') ?? params.get('surface') ?? 'personal')
    return Response.json(await api.getSecurityAlertCount(surface))
  } catch (err) {
    if (err instanceof ApiError) return Response.json({ error: err.code, message: err.message }, { status: err.status })
    return Response.json({ error: 'security_alert_count_failed', message: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
