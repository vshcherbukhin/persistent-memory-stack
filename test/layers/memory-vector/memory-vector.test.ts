import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RERANK_WEIGHTS,
  dbModeToWire,
  embeddingTopologyToLegacyMode,
  legacyModeToEmbeddingTopology,
  rerankScore,
  trustFactor,
  wireModeToDb,
} from '../../../layers/memory-vector/src/index.ts'

describe('memory-vector layer', () => {
  it('exposes embedding topology compatibility helpers from the layer path', () => {
    expect(dbModeToWire('server')).toBe('server')
    expect(dbModeToWire('client_bridge')).toBe('client-bridge')
    expect(wireModeToDb('client-bridge')).toBe('client_bridge')
    expect(legacyModeToEmbeddingTopology('server')).toBe('server-managed-embeddings')
    expect(embeddingTopologyToLegacyMode('client-managed-embeddings')).toBe('client-bridge')
  })

  it('exposes provenance-aware reranking from the layer path', () => {
    const nowMs = Date.parse('2026-07-08T12:00:00.000Z')
    const human = rerankScore({
      score: 0.8,
      createdAt: '2026-07-08T12:00:00.000Z',
      lastAccessedAt: null,
      confidence: 0.9,
      sourceProvenance: 'human_verified',
      shape: 'gotcha_fix',
    }, DEFAULT_RERANK_WEIGHTS, nowMs)
    const inferred = rerankScore({
      score: 0.8,
      createdAt: '2026-07-08T12:00:00.000Z',
      lastAccessedAt: null,
      confidence: 0.4,
      sourceProvenance: 'agent_inferred',
      shape: 'gotcha_fix',
    }, DEFAULT_RERANK_WEIGHTS, nowMs)

    expect(human).toBeGreaterThan(inferred)
    expect(trustFactor('agent_inferred', 0.4)).toBeCloseTo(0.3, 5)
  })
})
