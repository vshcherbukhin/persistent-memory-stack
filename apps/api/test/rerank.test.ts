/**
 * Unit: the Phase-9 memory rerank (api/src/services/rerank.ts).
 *
 * The composite score = (α·relevance + β·recency + γ·importance) · trust, where
 * `trust` is the strict-provenance gate. The load-bearing properties:
 *   • recency decays from last-access/creation with the configured half-life;
 *   • trust is always provenance × confidence (confidence is never used alone);
 *   • access recency can move a memory up or down without mutating its persisted
 *     confidence, provenance, or graph history.
 */
import { describe, it, expect } from 'vitest'
import {
  recencyDecay,
  trustFactor,
  rerankScore,
  importanceOf,
  DEFAULT_RERANK_WEIGHTS,
  type RerankInput,
} from '../src/services/rerank.ts'

const NOW = Date.parse('2026-06-28T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()

describe('recencyDecay', () => {
  it('is ~1.0 when fresh and ~0.5 at one half-life', () => {
    expect(recencyDecay(iso(0), null, NOW, 30)).toBeCloseTo(1.0, 5)
    expect(recencyDecay(iso(30), null, NOW, 30)).toBeCloseTo(0.5, 5)
    expect(recencyDecay(iso(60), null, NOW, 30)).toBeCloseTo(0.25, 5)
  })
  it('uses lastAccessedAt over createdAt (reinforcement resets the clock)', () => {
    // created 90d ago but accessed today → fresh.
    expect(recencyDecay(iso(90), iso(0), NOW, 30)).toBeCloseTo(1.0, 5)
  })
})

describe('trustFactor — the provenance gate', () => {
  it('always applies provenance factor × confidence (confidence never used alone)', () => {
    expect(trustFactor('human_verified', 1.0)).toBeCloseTo(1.0, 5)
    expect(trustFactor('agent_inferred', 1.0)).toBeCloseTo(0.75, 5)
    expect(trustFactor('agent_inferred', 0.5)).toBeCloseTo(0.375, 5)
  })
  it('clamps out-of-range confidence', () => {
    expect(trustFactor('human_verified', 5)).toBeCloseTo(1.0, 5)
    expect(trustFactor('human_verified', -1)).toBe(0)
  })
})

describe('importanceOf', () => {
  it('ranks durable shapes above loose ones', () => {
    expect(importanceOf('gotcha_fix')).toBeGreaterThan(importanceOf('atomic'))
  })
  it('defaults unknown shapes to a mid value', () => {
    expect(importanceOf('mystery')).toBeCloseTo(0.6, 5)
  })
})

describe('rerankScore — composite ordering', () => {
  const base = (over: Partial<RerankInput>): RerankInput => ({
    score: 0.8,
    createdAt: iso(1),
    lastAccessedAt: null,
    confidence: 0.6,
    sourceProvenance: 'agent_inferred',
    shape: 'gotcha_fix',
    ...over,
  })

  it('a fresh memory outranks an equal-everything stale one', () => {
    const fresh = rerankScore(base({ createdAt: iso(0) }), DEFAULT_RERANK_WEIGHTS, NOW)
    const stale = rerankScore(base({ createdAt: iso(365) }), DEFAULT_RERANK_WEIGHTS, NOW)
    expect(fresh).toBeGreaterThan(stale)
  })

  it('a high-confidence human_verified-source memory outranks a low-confidence agent one at equal relevance', () => {
    const trusted = rerankScore(base({ sourceProvenance: 'human_verified', confidence: 0.95 }), DEFAULT_RERANK_WEIGHTS, NOW)
    const shaky = rerankScore(base({ sourceProvenance: 'agent_inferred', confidence: 0.3 }), DEFAULT_RERANK_WEIGHTS, NOW)
    expect(trusted).toBeGreaterThan(shaky)
  })
})
