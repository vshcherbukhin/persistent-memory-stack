import { describe, expect, it } from 'vitest'
import { buildLiveUsageTicks, buildUsageTrend, buildUsageXAxisTicks, buildUsageXDomain, recordLiveUsageSample } from './usageTrend'

describe('usage trend chart data', () => {
  it('builds range windows as bucket totals without live samples', () => {
    expect(buildUsageTrend([
      { t: '2026-07-06T10:02:00.000Z', tokens: 20 },
      { t: '2026-07-06T10:01:00.000Z', tokens: 10 },
    ], '24h', 999, new Date('2026-07-06T10:10:00.000Z'), [
      { t: '2026-07-06T10:09:00.000Z', tokens: 50 },
    ])).toEqual([
      { t: '2026-07-05T10:10:00.000Z', ts: 1783246200000, tokens: 0 },
      { t: '2026-07-06T10:01:00.000Z', ts: 1783332060000, tokens: 10 },
      { t: '2026-07-06T10:02:00.000Z', ts: 1783332120000, tokens: 20 },
      { t: '2026-07-06T10:10:00.000Z', ts: 1783332600000, tokens: 0 },
    ])
  })

  it('creates a rolling low baseline for live usage when no samples exist', () => {
    expect(buildUsageTrend([], 'live', 0, new Date('2026-07-06T10:10:00.000Z'))).toEqual([
      { t: '2026-07-06T10:00:00.000Z', ts: 1783332000000, tokens: 0 },
      { t: '2026-07-06T10:01:00.000Z', ts: 1783332060000, tokens: 0 },
      { t: '2026-07-06T10:02:00.000Z', ts: 1783332120000, tokens: 0 },
      { t: '2026-07-06T10:03:00.000Z', ts: 1783332180000, tokens: 0 },
      { t: '2026-07-06T10:04:00.000Z', ts: 1783332240000, tokens: 0 },
      { t: '2026-07-06T10:05:00.000Z', ts: 1783332300000, tokens: 0 },
      { t: '2026-07-06T10:06:00.000Z', ts: 1783332360000, tokens: 0 },
      { t: '2026-07-06T10:07:00.000Z', ts: 1783332420000, tokens: 0 },
      { t: '2026-07-06T10:08:00.000Z', ts: 1783332480000, tokens: 0 },
      { t: '2026-07-06T10:09:00.000Z', ts: 1783332540000, tokens: 0 },
      { t: '2026-07-06T10:10:00.000Z', ts: 1783332600000, tokens: 0 },
    ])
  })

  it('records live total samples and keeps only the rolling range', () => {
    const samples = recordLiveUsageSample([
      { t: '2026-07-06T09:58:00.000Z', tokens: 10 },
      { t: '2026-07-06T10:00:30.000Z', tokens: 20 },
    ], 42, new Date('2026-07-06T10:10:20.000Z'))

    expect(samples).toEqual([
      { t: '2026-07-06T10:00:30.000Z', tokens: 20 },
      { t: '2026-07-06T10:10:20.000Z', tokens: 42 },
    ])
  })

  it('builds live usage as fixed one-minute buckets without a moving endpoint', () => {
    const trend = buildUsageTrend([], 'live', 0, new Date('2026-07-06T10:10:20.000Z'), [
      { t: '2026-07-06T10:09:00.000Z', tokens: 100 },
      { t: '2026-07-06T10:09:10.000Z', tokens: 130 },
      { t: '2026-07-06T10:09:50.000Z', tokens: 160 },
      { t: '2026-07-06T10:10:10.000Z', tokens: 220 },
    ])

    expect(trend).toHaveLength(11)
    expect(trend[0]).toEqual({ t: '2026-07-06T10:00:00.000Z', ts: 1783332000000, tokens: 0 })
    expect(trend.every((point) => point.ts % 60_000 === 0)).toBe(true)
    expect(trend.some((point) => point.t === '2026-07-06T10:10:20.000Z')).toBe(false)
    expect(trend.find((point) => point.t === '2026-07-06T10:09:00.000Z')).toEqual({
      t: '2026-07-06T10:09:00.000Z',
      ts: 1783332540000,
      tokens: 60,
    })
    expect(trend.find((point) => point.t === '2026-07-06T10:10:00.000Z')).toEqual({
      t: '2026-07-06T10:10:00.000Z',
      ts: 1783332600000,
      tokens: 60,
    })
    expect(trend.at(-1)).toEqual({ t: '2026-07-06T10:10:00.000Z', ts: 1783332600000, tokens: 60 })
  })

  it('uses a sliding live X domain independent of fixed bucket timestamps', () => {
    const now = new Date('2026-07-06T10:10:20.000Z')
    const trend = buildUsageTrend([], 'live', 0, now, [
      { t: '2026-07-06T10:09:00.000Z', tokens: 100 },
      { t: '2026-07-06T10:09:10.000Z', tokens: 130 },
      { t: '2026-07-06T10:09:50.000Z', tokens: 160 },
      { t: '2026-07-06T10:10:10.000Z', tokens: 220 },
    ])
    const domain = buildUsageXDomain('live', trend, now)

    expect(domain).toEqual([1783332020000, 1783332620000])
    expect(buildLiveUsageTicks(domain?.[0], domain?.[1])).toEqual([
      1783332060000,
      1783332120000,
      1783332180000,
      1783332240000,
      1783332300000,
      1783332360000,
      1783332420000,
      1783332480000,
      1783332540000,
      1783332600000,
    ])
  })

  it('uses trend endpoints as the X domain for non-live ranges', () => {
    const now = new Date('2026-07-06T10:10:00.000Z')
    const trend = buildUsageTrend([
      { t: '2026-07-06T10:02:00.000Z', tokens: 20 },
    ], '24h', 0, now)

    expect(buildUsageXDomain('24h', trend, now)).toEqual([1783246200000, 1783332600000])
  })

  it('builds X axis ticks that keep live time-only but date ranges date-aware', () => {
    const start = Date.parse('2026-07-05T10:10:00.000Z')
    const end = Date.parse('2026-07-06T10:10:00.000Z')

    expect(buildUsageXAxisTicks('live', start, end)).toEqual(buildLiveUsageTicks(start, end))
    expect(buildUsageXAxisTicks('24h', start, end)).toEqual([
      start,
      Date.parse('2026-07-05T16:10:00.000Z'),
      Date.parse('2026-07-05T22:10:00.000Z'),
      Date.parse('2026-07-06T04:10:00.000Z'),
      end,
    ])

    const sevenDayTicks = buildUsageXAxisTicks('7d', Date.parse('2026-06-29T10:10:00.000Z'), end)
    expect(sevenDayTicks).toHaveLength(7)
    expect(sevenDayTicks.every((tick) => {
      const date = new Date(tick)
      return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0
    })).toBe(true)
    expect(buildUsageXAxisTicks('30d', Date.parse('2026-06-06T10:10:00.000Z'), end)).toHaveLength(30)
    expect(buildUsageXAxisTicks('90d', Date.parse('2026-04-07T10:10:00.000Z'), end)).toHaveLength(90)
  })
})
