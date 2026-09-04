/**
 * Registry + naming + guard unit matrix. Pure functions, no network/DB — these
 * are the load-bearing validation paths a fresh session must keep green.
 */
import { describe, it, expect } from 'vitest'
import { validateModelDim, MODEL_REGISTRY } from '../src/embeddings/registry.ts'
import { vectorName } from '../src/embeddings/naming.ts'
import { resolveEmbedConfig } from '../src/embeddings/config.ts'
import { makeActivePin } from '../src/qdrant/collection.ts'
import { assertActivePin, ModelDimMismatchError } from '../src/qdrant/guard.ts'
import { planSwitch } from '../src/switch/migration.ts'
import { EmbeddingError } from '../src/types/index.ts'

describe('validateModelDim', () => {
  it('accepts the default qwen3-embedding:0.6b @ 1024', () => {
    const spec = validateModelDim('ollama', 'qwen3-embedding:0.6b', 1024)
    expect(spec.nativeDim).toBe(1024)
  })
  it('accepts a Matryoshka truncation for qwen3 (768)', () => {
    expect(() => validateModelDim('ollama', 'qwen3-embedding:0.6b', 768)).not.toThrow()
  })
  it('rejects a non-bucket dim for qwen3 (700)', () => {
    expect(() => validateModelDim('ollama', 'qwen3-embedding:0.6b', 700)).toThrow(EmbeddingError)
  })
  it('rejects a non-native dim for fixed nomic (512)', () => {
    expect(() => validateModelDim('ollama', 'nomic-embed-text', 512)).toThrow(/fixed at 768/)
  })
  it('rejects an unknown model', () => {
    expect(() => validateModelDim('ollama', 'made-up-model', 1024)).toThrow(/Unknown EMBED_MODEL/)
  })
  it('rejects a provider/model mismatch', () => {
    expect(() => validateModelDim('openai', 'qwen3-embedding:0.6b', 1024)).toThrow(/belongs to provider "ollama"/)
  })
  it('accepts any 1..3072 for OpenAI 3-large (open range)', () => {
    expect(() => validateModelDim('openai', 'text-embedding-3-large', 1536)).not.toThrow()
    expect(() => validateModelDim('openai', 'text-embedding-3-large', 3073)).toThrow()
  })
  it('accepts every Voyage bucket', () => {
    for (const d of [256, 512, 1024, 2048]) {
      expect(() => validateModelDim('voyage', 'voyage-3-large', d)).not.toThrow()
    }
  })
  it('accepts qwen3-embedding:8b at its native 4096 + Matryoshka buckets', () => {
    expect(validateModelDim('ollama', 'qwen3-embedding:8b', 4096).nativeDim).toBe(4096)
    for (const d of [4096, 2560, 1024, 768, 512, 256]) {
      expect(() => validateModelDim('ollama', 'qwen3-embedding:8b', d)).not.toThrow()
    }
    expect(() => validateModelDim('ollama', 'qwen3-embedding:8b', 2048)).toThrow(EmbeddingError)
  })
  it('registry has the expected models', () => {
    expect(Object.keys(MODEL_REGISTRY)).toEqual(
      expect.arrayContaining([
        'qwen3-embedding:0.6b',
        'qwen3-embedding:4b',
        'nomic-embed-text',
        'voyage-3-large',
        'text-embedding-3-large',
      ]),
    )
  })
})

describe('vectorName', () => {
  it('slugifies model + dim into the stable key', () => {
    expect(vectorName('qwen3-embedding:0.6b', 1024)).toBe('qwen3-embedding-0.6b__1024')
  })
  it('collapses runs of non-alphanumerics to single hyphens', () => {
    expect(vectorName('text-embedding-3-large', 3072)).toBe('text-embedding-3-large__3072')
  })
})

describe('resolveEmbedConfig', () => {
  it('defaults to ollama qwen3-embedding:4b @ 2560 when EMBED_* unset', () => {
    const cfg = resolveEmbedConfig({})
    expect(cfg).toMatchObject({ provider: 'ollama', model: 'qwen3-embedding:4b', dim: 2560 })
  })
  it('rejects the conflated enum value "cloud"', () => {
    expect(() => resolveEmbedConfig({ EMBED_PROVIDER: 'cloud' })).toThrow(/concrete-provider enum/)
  })
  it('requires VOYAGE_API_KEY for voyage', () => {
    expect(() =>
      resolveEmbedConfig({ EMBED_PROVIDER: 'voyage', EMBED_MODEL: 'voyage-3-large', EMBED_DIM: '1024' }),
    ).toThrow(/VOYAGE_API_KEY/)
  })
})

describe('assertActivePin (client-managed embeddings guard)', () => {
  const active = makeActivePin('qwen3-embedding:0.6b', 1024)
  it('passes a matching declared pin + correct-length vector', () => {
    expect(() =>
      assertActivePin({ modelId: 'qwen3-embedding:0.6b', dim: 1024, vector: new Array(1024).fill(0) }, active),
    ).not.toThrow()
  })
  it('rejects a different model', () => {
    expect(() =>
      assertActivePin({ modelId: 'nomic-embed-text', dim: 768, vector: new Array(768).fill(0) }, active),
    ).toThrow(ModelDimMismatchError)
  })
  it('rejects a correct model_id but wrong-length vector (defense in depth)', () => {
    expect(() =>
      assertActivePin({ modelId: 'qwen3-embedding:0.6b', dim: 1024, vector: new Array(512).fill(0) }, active),
    ).toThrow(ModelDimMismatchError)
  })
})

describe('planSwitch', () => {
  it('derives both pins with their named-vector keys', () => {
    const plan = planSwitch('qwen3-embedding:0.6b', 1024, 'nomic-embed-text', 768)
    expect(plan.from.vectorName).toBe('qwen3-embedding-0.6b__1024')
    expect(plan.to.vectorName).toBe('nomic-embed-text__768')
  })
})
