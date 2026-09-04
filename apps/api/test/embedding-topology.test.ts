import { describe, expect, it } from 'vitest'
import {
  dbModeToWire,
  embeddingTopologyToLegacyMode,
  legacyModeToEmbeddingTopology,
  wireModeToDb,
} from '../src/services/embedding-topology.ts'

describe('embedding topology naming', () => {
  it('exposes clear topology names while preserving server/client-bridge aliases', () => {
    expect(legacyModeToEmbeddingTopology('server')).toBe('server-managed-embeddings')
    expect(legacyModeToEmbeddingTopology('client-bridge')).toBe('client-managed-embeddings')
    expect(embeddingTopologyToLegacyMode('server-managed-embeddings')).toBe('server')
    expect(embeddingTopologyToLegacyMode('client-managed-embeddings')).toBe('client-bridge')
  })

  it('keeps the DB enum as a migration alias only', () => {
    expect(dbModeToWire('server')).toBe('server')
    expect(dbModeToWire('client_bridge')).toBe('client-bridge')
    expect(wireModeToDb('server')).toBe('server')
    expect(wireModeToDb('client-bridge')).toBe('client_bridge')
  })
})
