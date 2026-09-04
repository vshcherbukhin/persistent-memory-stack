import { api, ApiError } from '@/lib/api'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    return Response.json(await api.updateLogs())
  } catch (err) {
    if (err instanceof ApiError) return Response.json({ error: err.code, message: err.message }, { status: err.status })
    return Response.json({ error: 'update_logs_failed', message: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
