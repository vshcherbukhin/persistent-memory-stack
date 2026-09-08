import { beforeEach, describe, expect, it, vi } from 'vitest'

const health = vi.hoisted(() => ({
  getSafeHealth: vi.fn(),
}))

vi.mock('../src/services/model-dependency-health.ts', () => ({ modelDependencyHealth: health }))

import { getDashboardCapabilityHealth } from '../src/services/dashboard-capability-health.ts'

const safeHealth = (capability: string, observerScope: string) => ({
  capability,
  observerScope,
  state: 'unknown' as const,
  provider: null,
  model: null,
  lastSuccessAt: null,
  firstFailureAt: null,
  lastFailureAt: null,
  failureCode: null,
  safeMessage: null,
  retryable: null,
  consecutiveFailures: 0,
  observedAt: null,
  updatedAt: null,
})

describe('dashboard capability-health projection', () => {
  beforeEach(() => {
    health.getSafeHealth.mockReset()
  })

  it('uses the server observer for fact extraction and server-managed embeddings', async () => {
    health.getSafeHealth.mockImplementation(async (capability: string, scope: string) => safeHealth(capability, scope))

    const result = await getDashboardCapabilityHealth(
      { embeddingMode: 'server', activeEmbedModel: 'qwen3-embedding:4b' },
      '51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80',
    )

    expect(health.getSafeHealth).toHaveBeenNthCalledWith(1, 'fact_extraction', 'server')
    expect(health.getSafeHealth).toHaveBeenNthCalledWith(2, 'embeddings', 'server')
    expect(health.getSafeHealth).toHaveBeenNthCalledWith(3, 'ollama_host', 'host')
    expect(result.embeddings.observerScope).toBe('server')
  })

  it('projects client-managed embeddings only for the authenticated viewer scope', async () => {
    health.getSafeHealth.mockImplementation(async (capability: string, scope: string) => safeHealth(capability, scope))

    const result = await getDashboardCapabilityHealth(
      { embeddingMode: 'client-bridge', activeEmbedModel: 'qwen3-embedding:4b' },
      '43fa7904-0973-4676-9d29-b811c3ecefdf',
    )

    expect(health.getSafeHealth).toHaveBeenCalledWith(
      'embeddings',
      'client:43fa7904-0973-4676-9d29-b811c3ecefdf',
    )
    expect(result.embeddings.observerScope).toBe('client:43fa7904-0973-4676-9d29-b811c3ecefdf')
    expect(health.getSafeHealth).not.toHaveBeenCalledWith('ollama_host', 'host')
    expect(result.ollamaHost.state).toBe('unknown')
  })

  it.each(['text-embedding-3-small', 'voyage-4'])('does not project historical host failures for API embeddings (%s)', async (activeEmbedModel) => {
    health.getSafeHealth.mockImplementation(async (capability: string, scope: string) => ({
      ...safeHealth(capability, scope),
      state: 'unhealthy',
      failureCode: capability === 'ollama_host' ? 'ollama_host_unavailable' : 'embedding_provider_unavailable',
    }))

    const result = await getDashboardCapabilityHealth(
      { embeddingMode: 'server', activeEmbedModel },
      '51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80',
    )

    expect(health.getSafeHealth).not.toHaveBeenCalledWith('ollama_host', 'host')
    expect(result.ollamaHost).toMatchObject({ state: 'unknown', failureCode: null, model: null, consecutiveFailures: 0 })
    expect(result.embeddings.state).toBe('unhealthy')
    expect(result.factExtraction.state).toBe('unhealthy')
  })

  it('falls back to unknown instead of blocking an operational response when health storage is unavailable', async () => {
    health.getSafeHealth.mockRejectedValue(new Error('health table is temporarily unavailable'))

    await expect(getDashboardCapabilityHealth(
      { embeddingMode: 'server', activeEmbedModel: 'qwen3-embedding:4b' },
      '51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80',
    )).resolves.toMatchObject({
      factExtraction: { state: 'unknown', observerScope: 'server' },
      embeddings: { state: 'unknown', observerScope: 'server' },
      ollamaHost: { state: 'unknown', observerScope: 'host' },
    })
  })
})
