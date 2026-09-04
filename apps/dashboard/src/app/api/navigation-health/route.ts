import { api, ApiError, normalizeMemorySurface } from '@/lib/api'
import { canAccessControlPlane } from '@/lib/authz'
import { countServicesNeedingAttention, countWorkersNeedingAttention } from '@/lib/navigation-attention'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Small same-origin summary for the persistent sidebar. The browser never receives
 * the dashboard credential, runtime diagnostics, or Security counts to members.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const who = await requireSession()
    const params = new URL(req.url).searchParams
    const surface = normalizeMemorySurface(params.get('space') ?? 'personal')
    const includeRuntime = params.get('runtime') === '1'
    const includeSecurity = params.get('security') === '1' && canAccessControlPlane(who.adminLevel)

    const [services, workers, security] = await Promise.allSettled([
      includeRuntime ? api.listServices().then(({ services }) => countServicesNeedingAttention(services)) : Promise.resolve(0),
      includeRuntime
        ? api.listWorkers().then(({ workers, liveness }) => countWorkersNeedingAttention(workers, liveness))
        : Promise.resolve(0),
      includeSecurity ? api.getSecurityAlertCount(surface).then(({ open }) => open) : Promise.resolve(0),
    ])

    return Response.json({
      ...(services.status === 'fulfilled' ? { servicesDown: services.value } : {}),
      ...(workers.status === 'fulfilled' ? { workersDown: workers.value } : {}),
      ...(security.status === 'fulfilled' ? { securityOpen: security.value } : {}),
    })
  } catch (err) {
    if (err instanceof ApiError) return Response.json({ error: err.code, message: err.message }, { status: err.status })
    return Response.json({ error: 'navigation_health_failed', message: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
