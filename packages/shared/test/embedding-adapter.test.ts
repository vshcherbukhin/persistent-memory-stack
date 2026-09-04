/**
 * Embedding adapter unit matrix — provider SELECTION (makeEmbedder picks the
 * right impl per EMBED_PROVIDER) + the model→dim REGISTRY contract that gates
 * construction. Pure: no network, no DB (no embed() call is made, only the
 * synchronous validate-and-construct path).
 */
import { describe, it, expect } from 'vitest'
import { makeEmbedder, makeEmbedderFromEnv } from '../src/embeddings/factory.ts'
import { OllamaEmbedder } from '../src/embeddings/ollama.ts'
import { VoyageEmbedder } from '../src/embeddings/voyage.ts'
import { OpenAIEmbedder } from '../src/embeddings/openai.ts'
import { validateModelDim, MODEL_REGISTRY } from '../src/embeddings/registry.ts'
import type { EmbedConfig } from '../src/embeddings/config.ts'
import { EmbeddingError } from '../src/types/index.ts'

function cfg(over: Partial<EmbedConfig> & Pick<EmbedConfig, 'provider' | 'model' | 'dim'>): EmbedConfig {
  return {
    ollamaUrl: 'http://localhost:11434',
    batchSize: 16,
    maxRetries: 4,
    requestTimeoutMs: 30000,
    ...over,
  }
}

describe('makeEmbedder — provider selection', () => {
  it('constructs an OllamaEmbedder for provider=ollama', () => {
    const e = makeEmbedder(cfg({ provider: 'ollama', model: 'qwen3-embedding:0.6b', dim: 1024 }))
    expect(e).toBeInstanceOf(OllamaEmbedder)
    expect(e.provider).toBe('ollama')
  })
  it('constructs a VoyageEmbedder for provider=voyage', () => {
    const e = makeEmbedder(cfg({ provider: 'voyage', model: 'voyage-3-large', dim: 1024 }))
    expect(e).toBeInstanceOf(VoyageEmbedder)
    expect(e.provider).toBe('voyage')
  })
  it('constructs an OpenAIEmbedder for provider=openai', () => {
    const e = makeEmbedder(cfg({ provider: 'openai', model: 'text-embedding-3-large', dim: 1536 }))
    expect(e).toBeInstanceOf(OpenAIEmbedder)
    expect(e.provider).toBe('openai')
  })
  it('threads model + dim onto the instance and derives the named-vector key', () => {
    const e = makeEmbedder(cfg({ provider: 'ollama', model: 'qwen3-embedding:0.6b', dim: 768 }))
    expect(e.model).toBe('qwen3-embedding:0.6b')
    expect(e.dim).toBe(768)
    expect(e.vectorName).toBe('qwen3-embedding-0.6b__768')
  })
  it('validates BEFORE constructing: a bad (provider,model,dim) triple throws, no instance built', () => {
    // qwen3 is an ollama model — selecting it under provider=openai must fail in the factory.
    expect(() => makeEmbedder(cfg({ provider: 'openai', model: 'qwen3-embedding:0.6b', dim: 1024 }))).toThrow(
      EmbeddingError,
    )
    // unsupported dim for the chosen model also fails at construction.
    expect(() => makeEmbedder(cfg({ provider: 'ollama', model: 'qwen3-embedding:0.6b', dim: 700 }))).toThrow(
      EmbeddingError,
    )
  })
})

describe('makeEmbedderFromEnv — env → provider selection', () => {
  it('defaults to an OllamaEmbedder (qwen3-embedding:4b @ 2560) on empty env', () => {
    const e = makeEmbedderFromEnv({})
    expect(e).toBeInstanceOf(OllamaEmbedder)
    expect(e.model).toBe('qwen3-embedding:4b')
    expect(e.dim).toBe(2560)
  })
  it('selects OpenAI from EMBED_PROVIDER + required key', () => {
    const e = makeEmbedderFromEnv({
      EMBED_PROVIDER: 'openai',
      EMBED_MODEL: 'text-embedding-3-small',
      EMBED_DIM: '512',
      OPENAI_API_KEY: 'sk-test',
    })
    expect(e).toBeInstanceOf(OpenAIEmbedder)
    expect(e.dim).toBe(512)
  })
})

describe('model→dim registry', () => {
  it('every registry entry validates at its native dim and records its declared provider', () => {
    for (const [model, spec] of Object.entries(MODEL_REGISTRY)) {
      const resolved = validateModelDim(spec.provider, model, spec.nativeDim)
      expect(resolved.provider).toBe(spec.provider)
      expect(resolved.nativeDim).toBe(spec.nativeDim)
    }
  })
  it('discrete-bucket models accept every listed dim and reject an off-bucket dim', () => {
    for (const [model, spec] of Object.entries(MODEL_REGISTRY)) {
      if (!spec.supportedDims) continue
      for (const d of spec.supportedDims) {
        expect(() => validateModelDim(spec.provider, model, d)).not.toThrow()
      }
      // 7 is not a bucket for any model in the registry.
      expect(() => validateModelDim(spec.provider, model, 7)).toThrow(EmbeddingError)
    }
  })
  it('open-range (OpenAI Matryoshka) models accept 1..native and reject native+1 and 0', () => {
    for (const [model, spec] of Object.entries(MODEL_REGISTRY)) {
      if (spec.supportedDims) continue
      expect(() => validateModelDim(spec.provider, model, 1)).not.toThrow()
      expect(() => validateModelDim(spec.provider, model, spec.nativeDim)).not.toThrow()
      expect(() => validateModelDim(spec.provider, model, spec.nativeDim + 1)).toThrow(EmbeddingError)
      expect(() => validateModelDim(spec.provider, model, 0)).toThrow(EmbeddingError)
    }
  })
  it('a fixed-dim model (nomic, single bucket) surfaces the targeted "fixed at" nudge', () => {
    expect(() => validateModelDim('ollama', 'nomic-embed-text', 256)).toThrow(/fixed at 768/)
  })
  it('classifies every failure as an EmbeddingError of kind="config"', () => {
    try {
      validateModelDim('ollama', 'totally-unknown', 1024)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingError)
      expect((err as EmbeddingError).meta.kind).toBe('config')
    }
  })
})
