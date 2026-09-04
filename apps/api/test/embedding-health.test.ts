import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmbeddingError } from '@pm/shared'

const health = vi.hoisted(() => ({
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}))

vi.mock('../src/services/model-dependency-health.ts', () => ({
  modelDependencyHealth: health,
}))

import { EmbeddingDimensionMismatchError, EmbeddingProviderError, withEmbeddingHealth } from '../src/services/embedding-health.ts'

describe('embedding capability health', () => {
  beforeEach(() => {
    health.recordSuccess.mockReset()
    health.recordFailure.mockReset()
    health.recordSuccess.mockResolvedValue(undefined)
    health.recordFailure.mockResolvedValue(undefined)
  })

  it('records server success after a real embedding request', async () => {
    await expect(withEmbeddingHealth(
      { observerScope: 'server', provider: 'ollama', model: 'qwen3-embedding:4b' },
      async () => ({ vectors: [[0.1]] }),
    )).resolves.toEqual({ vectors: [[0.1]] })

    expect(health.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'embeddings',
      observerScope: 'server',
      provider: 'ollama',
      model: 'qwen3-embedding:4b',
      observedAt: expect.any(Date),
    }))
  })

  it('normalizes a quota response without leaking the raw provider payload', async () => {
    const raw = 'billing details: bearer sk-secret must not reach a caller'

    await expect(withEmbeddingHealth(
      { observerScope: 'server', provider: 'openai', model: 'text-embedding-3-small' },
      async () => {
        throw new EmbeddingError(raw, {
          provider: 'openai', model: 'text-embedding-3-small', kind: 'http', status: 402,
        })
      },
    )).rejects.toMatchObject<Partial<EmbeddingProviderError>>({
      code: 'embedding_quota_exhausted',
      message: 'Embeddings are out of tokens.',
      retryable: false,
    })

    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'embeddings',
      observerScope: 'server',
      failure: { code: 'embedding_quota_exhausted', state: 'unhealthy' },
    }))
  })

  it('classifies a missing configured model as non-retryable and preserves no raw error text', async () => {
    const raw = 'model private-tenant-embedding is not pulled'

    await expect(withEmbeddingHealth(
      { observerScope: 'server', provider: 'ollama', model: 'qwen3-embedding:4b' },
      async () => { throw new EmbeddingError(raw, { provider: 'ollama', model: 'qwen3-embedding:4b', kind: 'config' }) },
    )).rejects.toMatchObject<Partial<EmbeddingProviderError>>({
      code: 'embedding_model_unavailable',
      message: 'Configured embedding model is unavailable.',
      retryable: false,
    })

    expect(JSON.stringify(health.recordFailure.mock.calls)).not.toContain(raw)
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: 'embedding_model_unavailable', state: 'unhealthy' },
    }))
  })

  it('does not turn an otherwise successful operation into a failure when telemetry is unavailable', async () => {
    health.recordSuccess.mockRejectedValueOnce(new Error('health database unavailable'))

    await expect(withEmbeddingHealth(
      { observerScope: 'server', provider: 'ollama', model: 'qwen3-embedding:4b' },
      async () => 'embedded',
    )).resolves.toBe('embedded')
  })

  it('records a dimension mismatch as unhealthy and never clears existing health with success', async () => {
    const result = await withEmbeddingHealth(
      { observerScope: 'server', provider: 'ollama', model: 'qwen3-embedding:4b' },
      async () => { throw new EmbeddingDimensionMismatchError(1024, 2560) },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'embedding_model_unavailable',
        message: 'Embedding returned 1024 dimensions, expected 2560.',
        retryable: false,
      },
    })

    expect(health.recordSuccess).not.toHaveBeenCalled()
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: 'embedding_model_unavailable', state: 'unhealthy' },
    }))
  })
})
