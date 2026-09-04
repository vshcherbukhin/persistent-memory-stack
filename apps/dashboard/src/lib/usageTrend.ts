import type { UsageTrendPoint, UsageWindow } from './types'

const LIVE_WINDOW_MS = 10 * 60 * 1000
const LIVE_STEP_MS = 60 * 1000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const RANGE_WINDOW_MS: Record<Exclude<UsageWindow, 'live'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}
const RANGE_DATE_TICK_COUNT: Record<Exclude<UsageWindow, 'live' | '24h'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

export interface UsageChartPoint extends UsageTrendPoint {
  ts: number
}

function validTime(value: string): number | null {
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

function toChartPoint(point: UsageTrendPoint): UsageChartPoint | null {
  const ts = validTime(point.t)
  if (ts === null) return null
  return { t: point.t, ts, tokens: Math.max(0, Number(point.tokens) || 0) }
}

function sortedTrend(points: UsageTrendPoint[]): UsageChartPoint[] {
  return [...points]
    .map(toChartPoint)
    .filter((point): point is UsageChartPoint => point !== null)
    .sort((a, b) => a.ts - b.ts)
}

function floorMinute(ms: number): number {
  return Math.floor(ms / LIVE_STEP_MS) * LIVE_STEP_MS
}

function ceilMinute(ms: number): number {
  return Math.ceil(ms / LIVE_STEP_MS) * LIVE_STEP_MS
}

function point(ts: number, tokens: number): UsageChartPoint {
  return { t: new Date(ts).toISOString(), ts, tokens }
}

export function recordLiveUsageSample(
  samples: UsageTrendPoint[],
  totalTokens: number,
  now = new Date(),
): UsageTrendPoint[] {
  const nowMs = now.getTime()
  const keepAfterMs = nowMs - LIVE_WINDOW_MS
  const byTime = new Map<number, UsageTrendPoint>()
  for (const sample of sortedTrend(samples)) {
    if (sample.ts >= keepAfterMs) byTime.set(sample.ts, { t: sample.t, tokens: sample.tokens })
  }
  byTime.set(nowMs, { t: now.toISOString(), tokens: Math.max(0, Math.round(totalTokens || 0)) })
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, sample]) => sample)
}

function buildLiveTrend(samples: UsageTrendPoint[], now: Date): UsageChartPoint[] {
  const endMs = now.getTime()
  const windowStartMs = endMs - LIVE_WINDOW_MS
  const startBucketMs = floorMinute(windowStartMs)
  const endBucketMs = floorMinute(endMs)
  const bucketTotals = new Map<number, number>()
  const sorted = sortedTrend(samples)

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!
    const current = sorted[i]!
    if (current.ts < windowStartMs || current.ts > endMs) continue
    const delta = Math.max(0, current.tokens - previous.tokens)
    const bucketMs = floorMinute(current.ts)
    if (bucketMs < startBucketMs || bucketMs > endBucketMs) continue
    bucketTotals.set(bucketMs, (bucketTotals.get(bucketMs) ?? 0) + delta)
  }

  const trend: UsageChartPoint[] = []
  for (let ts = startBucketMs; ts <= endBucketMs; ts += LIVE_STEP_MS) {
    trend.push(point(ts, bucketTotals.get(ts) ?? 0))
  }
  return trend
}

function buildRangeTrend(points: UsageTrendPoint[], window: Exclude<UsageWindow, 'live'>, now: Date): UsageChartPoint[] {
  const endMs = now.getTime()
  const startMs = endMs - RANGE_WINDOW_MS[window]
  const trend: UsageChartPoint[] = [point(startMs, 0)]

  for (const current of sortedTrend(points)) {
    if (current.ts < startMs || current.ts > endMs) continue
    if (trend.at(-1)?.ts === current.ts) {
      trend[trend.length - 1] = { ...current, tokens: trend[trend.length - 1]!.tokens + current.tokens }
    } else {
      trend.push(current)
    }
  }

  if (trend.at(-1)?.ts !== endMs) {
    trend.push(point(endMs, 0))
  }
  return trend
}

export function buildLiveUsageTicks(startMs: number | undefined, endMs: number | undefined): number[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs == null || endMs == null || startMs >= endMs) {
    return []
  }
  const ticks: number[] = []
  for (let ts = ceilMinute(startMs); ts <= floorMinute(endMs); ts += LIVE_STEP_MS) {
    ticks.push(ts)
  }
  return ticks
}

function localDayStart(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function buildUsageXAxisTicks(
  window: UsageWindow,
  startMs: number | undefined,
  endMs: number | undefined,
): number[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs == null || endMs == null || startMs >= endMs) {
    return []
  }
  if (window === 'live') return buildLiveUsageTicks(startMs, endMs)
  if (window === '24h') {
    const ticks: number[] = []
    for (let ts = startMs; ts < endMs; ts += SIX_HOURS_MS) {
      ticks.push(ts)
    }
    if (ticks.at(-1) !== endMs) ticks.push(endMs)
    return ticks
  }

  const count = RANGE_DATE_TICK_COUNT[window]
  const endDay = localDayStart(endMs)
  const ticks: number[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(endDay)
    date.setDate(date.getDate() - i)
    const ts = date.getTime()
    if (ts >= startMs && ts <= endMs) ticks.push(ts)
  }
  return ticks
}

export function buildUsageXDomain(
  window: UsageWindow,
  trend: UsageChartPoint[],
  now = new Date(),
): [number, number] | undefined {
  if (window === 'live') {
    const endMs = now.getTime()
    if (!Number.isFinite(endMs)) return undefined
    return [endMs - LIVE_WINDOW_MS, endMs]
  }

  const start = trend[0]?.ts
  const end = trend.at(-1)?.ts
  return Number.isFinite(start) && Number.isFinite(end) && start != null && end != null ? [start, end] : undefined
}

export function buildUsageTrend(
  points: UsageTrendPoint[],
  window: UsageWindow,
  totalTokens = 0,
  now = new Date(),
  liveSamples: UsageTrendPoint[] = [],
): UsageChartPoint[] {
  if (window !== 'live') return buildRangeTrend(points, window, now)

  const samples = liveSamples.length ? liveSamples : recordLiveUsageSample([], totalTokens, now)
  return buildLiveTrend(samples, now)
}
