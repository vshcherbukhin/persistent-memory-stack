/**
 * Usage metrics — pure cost/window logic, the aggregation reduce (ownerPrisma
 * mocked), and the /internal/usage bearer gate. No live DB / no app.inject.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// config validates the full env at import; mock it (the /internal/usage route imports it).
vi.mock('../src/config.ts', () => ({ config: { USAGE_INGEST_TOKEN: 'x' } }))
// Mock @pm/db so aggregateUsage's ownerPrisma calls are fake.
const { groupBy, findMany } = vi.hoisted(() => ({ groupBy: vi.fn(), findMany: vi.fn() }))
vi.mock('@pm/db', () => ({
  ownerPrisma: { modelUsageRollup: { groupBy }, appUser: { findMany } },
  recordUsageFireAndForget: vi.fn(),
}))

import { costFor } from '../src/services/usage-prices.ts'
import { windowToRange, aggregateUsage } from '../src/services/usage.ts'
import { bearerOk } from '../src/routes/internal/usage.ts'

describe('costFor', () => {
  it('prices known LLMs from the in/out rates', () => {
    expect(costFor('claude-sonnet-4-6', 1_000_000, 1_000_000)).toEqual({ cost: 18, estimated: false }) // 3 + 15
    expect(costFor('gpt-4o', 2_000_000, 0)).toEqual({ cost: 5, estimated: false }) // 2 * 2.5
  })
  it('local embedding models are known-free', () => {
    expect(costFor('qwen3-embedding:4b', 5_000_000, 0)).toEqual({ cost: 0, estimated: false })
  })
  it('unknown model → 0 + estimated', () => {
    expect(costFor('some-future-model', 1000, 1000)).toEqual({ cost: 0, estimated: true })
  })
})

describe('windowToRange', () => {
  const now = new Date('2026-06-26T12:00:00Z')
  it('maps each window to since + minutes', () => {
    expect(windowToRange('live', now)).toEqual({ since: new Date('2026-06-26T11:00:00Z'), minutes: 60 })
    expect(windowToRange('24h', now).minutes).toBe(24 * 60)
    expect(windowToRange('7d', now).since.toISOString()).toBe('2026-06-19T12:00:00.000Z')
    expect(windowToRange('90d', now).minutes).toBe(90 * 24 * 60)
  })
})

describe('aggregateUsage', () => {
  beforeEach(() => {
    groupBy.mockReset()
    findMany.mockReset()
  })
  it('reduces grouped rows → totals/avg/rpm/cost, BigInt→Number', async () => {
    groupBy
      .mockResolvedValueOnce([
        { service: 'fact-extraction', model: 'claude-sonnet-4-6', _sum: { tokensIn: 1_000_000n, tokensOut: 1_000_000n, requests: 100 } },
        { service: 'embeddings', model: 'qwen3-embedding:4b', _sum: { tokensIn: 500n, tokensOut: 0n, requests: 50 } },
      ]) // grouped by service+model
      .mockResolvedValueOnce([
        { hourUtc: new Date('2026-06-26T10:00:00Z'), _sum: { tokensIn: 1000n, tokensOut: 200n } },
      ]) // trend
      .mockResolvedValueOnce([
        { actorId: '11111111-1111-4111-8111-111111111111', _sum: { tokensIn: 25n, tokensOut: 75n, requests: 4 } },
        { actorId: 'system', _sum: { tokensIn: 10n, tokensOut: 0n, requests: 1 } },
        { actorId: 'worker', _sum: { tokensIn: 3n, tokensOut: 7n, requests: 2 } },
      ]) // grouped by actor
    findMany.mockResolvedValueOnce([{ id: '11111111-1111-4111-8111-111111111111', displayName: 'Ada', email: 'ada@example.test' }])
    const r = await aggregateUsage({ window: '24h', now: new Date('2026-06-26T12:00:00Z') })
    const sonnet = r.rows.find((x) => x.model === 'claude-sonnet-4-6')!
    expect(sonnet.tokensIn).toBe(1_000_000) // number, not bigint
    expect(sonnet.avgTokensPerReq).toBe(20000) // 2,000,000 / 100
    expect(sonnet.cost).toBe(18)
    expect(sonnet.estimated).toBe(false)
    expect(r.totals.tokens).toBe(2_000_500)
    expect(r.totals.cost).toBe(18)
    expect(r.trend).toEqual([{ t: '2026-06-26T10:00:00.000Z', tokens: 1200 }])
    expect(r.users).toEqual([
      { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Ada', email: 'ada@example.test', tokens: 100, requests: 4 },
      { userId: null, displayName: 'System / background', email: null, tokens: 10, requests: 1 },
      { userId: null, displayName: 'System / background', email: null, tokens: 10, requests: 2 },
    ])
  })
  it('empty window → zero totals + empty rows/trend', async () => {
    groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    findMany.mockResolvedValueOnce([])
    const r = await aggregateUsage({ window: '90d' })
    expect(r.rows).toEqual([])
    expect(r.trend).toEqual([])
    expect(r.users).toEqual([])
    expect(r.totals).toEqual({ tokens: 0, requests: 0, cost: 0 })
  })
})

describe('bearerOk (/internal/usage gate)', () => {
  it('fails closed on empty token; accepts only the exact bearer', () => {
    expect(bearerOk('Bearer x', '')).toBe(false)
    expect(bearerOk('Bearer s3cret', 's3cret')).toBe(true)
    expect(bearerOk('Bearer wrong', 's3cret')).toBe(false)
    expect(bearerOk(undefined, 's3cret')).toBe(false)
    expect(bearerOk('s3cret', 's3cret')).toBe(false) // missing "Bearer "
  })
})
