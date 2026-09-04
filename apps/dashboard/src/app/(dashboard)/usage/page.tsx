import { requireSession } from '@/lib/session'
import { normalizeMemorySurface } from '@/lib/api'
import { getUsageAction } from './actions'
import { UsageClient } from './UsageClient'

export const dynamic = 'force-dynamic'

/**
 * Token usage — model-usage metrics. Any valid session may view (org-wide,
 * read-only). Per-service, per-model, and per-user token/request stats with a
 * window selector and Recharts trend chart. Backed by /dashboard/usage.
 */
export default async function UsagePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  const surface = normalizeMemorySurface(Array.isArray(params.space) ? params.space[0] : params.space)
  await requireSession()
  const initial = await getUsageAction('24h', surface)
  return <UsageClient initial={initial} surface={surface} />
}
