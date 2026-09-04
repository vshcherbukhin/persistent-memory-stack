/**
 * persistent-memory-api — usage aggregation for the dashboard Usage page.
 *
 * Reads the `model_usage_rollup` CONTROL table via ownerPrisma (no RLS, no tenant
 * tx), aggregates over the selected window, and computes avg / req-per-min / cost.
 * BigInt sums are converted to Number for the JSON (zod `z.number()`) response —
 * 90 days of tokens stays far below Number.MAX_SAFE_INTEGER. The client groups the
 * per-(service,model) rows into the by-service / by-model views and renders the
 * per-actor aggregate as the "By user requests" table.
 */
import { ownerPrisma } from '@pm/db'
import { costFor } from './usage-prices.ts'

export type UsageWindow = 'live' | '24h' | '7d' | '30d' | '90d'

const WINDOW_HOURS: Record<UsageWindow, number> = { live: 1, '24h': 24, '7d': 24 * 7, '30d': 24 * 30, '90d': 24 * 90 }

/** Window → the inclusive `since` bound + the window length in minutes (for rate). Pure. */
export function windowToRange(window: UsageWindow, now: Date): { since: Date; minutes: number } {
  const hours = WINDOW_HOURS[window]
  return { since: new Date(now.getTime() - hours * 3_600_000), minutes: hours * 60 }
}

export interface UsageRow {
  service: string
  model: string
  tokensIn: number
  tokensOut: number
  requests: number
  avgTokensPerReq: number
  rpm: number
  cost: number
  estimated: boolean
}
export interface UsageTotals {
  tokens: number
  requests: number
  cost: number
}
export interface UsageTrendPoint {
  t: string
  tokens: number
}
export interface UserUsageRow {
  userId: string | null
  displayName: string
  email: string | null
  tokens: number
  requests: number
}
export interface UsageResult {
  window: UsageWindow
  totals: UsageTotals
  rows: UsageRow[]
  trend: UsageTrendPoint[]
  users: UserUsageRow[]
}

const n = (v: bigint | null | undefined): number => Number(v ?? 0n)
// `actorId` is intentionally a free-form audit identifier: background workers
// use values such as "worker" while human actors use AppUser UUIDs.  Never pass
// a system identifier into AppUser.id (a PostgreSQL uuid column).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUserActor = (actorId: string): boolean => UUID.test(actorId)

/** Aggregate usage over the window. groupBy is done by the client; this returns
 *  per-(service,model) rows + window totals + an hourly trend for the sparkline. */
export async function aggregateUsage(opts: { window: UsageWindow; now?: Date }): Promise<UsageResult> {
  const now = opts.now ?? new Date()
  const { since, minutes } = windowToRange(opts.window, now)

  const grouped = await ownerPrisma.modelUsageRollup.groupBy({
    by: ['service', 'model'],
    where: { hourUtc: { gte: since } },
    _sum: { tokensIn: true, tokensOut: true, requests: true },
  })

  const rows: UsageRow[] = grouped.map((g) => {
    const tokensIn = n(g._sum.tokensIn)
    const tokensOut = n(g._sum.tokensOut)
    const requests = g._sum.requests ?? 0
    const { cost, estimated } = costFor(g.model, tokensIn, tokensOut)
    return {
      service: g.service,
      model: g.model,
      tokensIn,
      tokensOut,
      requests,
      avgTokensPerReq: requests ? Math.round((tokensIn + tokensOut) / requests) : 0,
      rpm: minutes ? Number(((requests / minutes)).toFixed(3)) : 0,
      cost,
      estimated,
    }
  })

  const totals: UsageTotals = rows.reduce(
    (acc, r) => ({ tokens: acc.tokens + r.tokensIn + r.tokensOut, requests: acc.requests + r.requests, cost: acc.cost + r.cost }),
    { tokens: 0, requests: 0, cost: 0 },
  )

  const trendRows = await ownerPrisma.modelUsageRollup.groupBy({
    by: ['hourUtc'],
    where: { hourUtc: { gte: since } },
    _sum: { tokensIn: true, tokensOut: true },
  })
  const trend: UsageTrendPoint[] = trendRows
    .map((t) => ({ t: t.hourUtc.toISOString(), tokens: n(t._sum.tokensIn) + n(t._sum.tokensOut) }))
    .sort((a, b) => a.t.localeCompare(b.t))

  const userGroups = await ownerPrisma.modelUsageRollup.groupBy({
    by: ['actorId'],
    where: { hourUtc: { gte: since } },
    _sum: { tokensIn: true, tokensOut: true, requests: true },
  })
  const userIds = userGroups.map((g) => g.actorId).filter(isUserActor)
  const usersById = new Map(
    (await ownerPrisma.appUser.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true, email: true },
    })).map((u) => [u.id, u]),
  )
  const users: UserUsageRow[] = userGroups
    .map((g) => {
      const tokens = n(g._sum.tokensIn) + n(g._sum.tokensOut)
      const requests = g._sum.requests ?? 0
      if (!isUserActor(g.actorId)) {
        return { userId: null, displayName: 'System / background', email: null, tokens, requests }
      }
      const user = usersById.get(g.actorId)
      return {
        userId: g.actorId,
        displayName: user?.displayName ?? 'Deleted user',
        email: user?.email ?? null,
        tokens,
        requests,
      }
    })
    .sort((a, b) => b.tokens - a.tokens)

  return { window: opts.window, totals, rows, trend, users }
}
