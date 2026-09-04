import { describe, expect, it, vi } from 'vitest'
import { EmbeddingError } from '@pm/shared'
import { withWorkerEmbeddingHealth } from '../src/embedding-health.ts'

const embedder = {
  provider: 'ollama' as const,
  model: 'qwen3-embedding:4b',
}

describe('worker embedding health', () => {
  it('records a canonical failure and rethrows the original error so IngestJob handling is unchanged', async () => {
    const record = vi.fn(async () => undefined)
    const original = new EmbeddingError('model qwen3-embedding:4b is not pulled', {
      provider: 'ollama', model: 'qwen3-embedding:4b', kind: 'config',
    })

    await expect(withWorkerEmbeddingHealth(embedder, async () => { throw original }, record)).rejects.toBe(original)

    expect(record).toHaveBeenCalledWith({
      capability: 'embeddings', observerScope: 'server', provider: 'ollama', model: 'qwen3-embedding:4b',
      failure: { code: 'embedding_model_unavailable', state: 'unhealthy' },
    })
    expect(JSON.stringify(record.mock.calls)).not.toContain('not pulled')
  })

  it('records a later real success so an embedding outage recovers automatically', async () => {
    const record = vi.fn(async () => undefined)

    await expect(withWorkerEmbeddingHealth(embedder, async () => ({ vectors: [[0.1]] }), record))
      .resolves.toEqual({ vectors: [[0.1]] })

    expect(record).toHaveBeenCalledWith({
      capability: 'embeddings', observerScope: 'server', provider: 'ollama', model: 'qwen3-embedding:4b',
      success: true,
    })
  })

  it('does not allow unavailable health telemetry to alter the embedding outcome', async () => {
    const record = vi.fn(async () => { throw new Error('health unavailable') })

    await expect(withWorkerEmbeddingHealth(embedder, async () => 'embedded', record)).resolves.toBe('embedded')
  })
})
