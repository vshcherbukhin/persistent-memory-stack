import { api, ApiError, ForbiddenError, UnauthorizedError } from '@/lib/api'
import { requireControlPlane } from '@/lib/session'
import type { BrowserPushSubscriptionInput } from '@/lib/types'

export const dynamic = 'force-dynamic'

function errorResponse(err: unknown, fallback: string): Response {
  if (err instanceof UnauthorizedError) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (err instanceof ForbiddenError) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (err instanceof ApiError) return Response.json({ error: err.code, message: err.message }, { status: err.status })
  return Response.json({ error: fallback, message: err instanceof Error ? err.message : String(err) }, { status: 500 })
}

export async function PUT(req: Request): Promise<Response> {
  try {
    await requireControlPlane()
    const body = (await req.json()) as BrowserPushSubscriptionInput
    return Response.json(await api.saveBrowserPushSubscription(body))
  } catch (err) {
    return errorResponse(err, 'browser_push_subscription_save_failed')
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireControlPlane()
    const body = await req.json().catch(() => ({})) as { endpoint?: string }
    return Response.json(await api.deleteBrowserPushSubscription(body.endpoint))
  } catch (err) {
    return errorResponse(err, 'browser_push_subscription_delete_failed')
  }
}
