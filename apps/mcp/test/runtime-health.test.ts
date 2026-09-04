import { describe, expect, it, vi } from 'vitest'

const makeEmbedderForPin = vi.hoisted(() => vi.fn(() => ({
  provider: 'ollama',
  embed: vi.fn(async () => ({ vectors: [[0.1]] })),
})))

vi.mock('@pm/shared', () => ({ makeEmbedderForPin }))

import { resolveRuntime } from '../src/runtime.ts'

describe('client-managed runtime health reporter', () => {
  it('posts only the canonical embedding outcome to the API', async () => {
    const api = {
      get: vi.fn(async () => ({
        embeddingMode: 'client-bridge', activeModel: 'qwen3-embedding:4b', activeDim: 2560,
        activeVectorName: 'qwen3_embedding_4b__2560', deploymentMode: 'local',
      })),
      post: vi.fn(async () => ({ ok: true })),
    }
    const runtime = await resolveRuntime(api, {
      API_URL: 'http://127.0.0.1:4319', OLLAMA_URL: 'http://127.0.0.1:11434',
      PM_API_TIMEOUT_MS: 1000,
    } as never)

    await runtime.reportEmbeddingHealth!({ ok: false, code: 'embedding_model_unavailable' })

    expect(api.post).toHaveBeenCalledWith('/embedding-health/observation', {
      provider: 'ollama',
      model: 'qwen3-embedding:4b',
      outcome: { ok: false, code: 'embedding_model_unavailable' },
    })
  })
})
