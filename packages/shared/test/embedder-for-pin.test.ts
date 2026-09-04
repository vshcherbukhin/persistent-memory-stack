/**
 * makeEmbedderForPin — builds an embedder for a SPECIFIC (model, dim), taking the
 * provider from the registry (not EMBED_*). Used by the P10 live-pin path + the
 * model-switch driver. Construction is side-effect-free (no network), so we only
 * assert it resolves a usable embedder and fails fast on a bad pin.
 */
import { describe, it, expect } from 'vitest'
import { makeEmbedderForPin } from '../src/embeddings/factory.ts'

describe('makeEmbedderForPin', () => {
  it('builds an embedder for a valid (model, dim) regardless of EMBED_* env', () => {
    // A truncation dim of a known ollama model; provider derived from the registry.
    const e = makeEmbedderForPin('qwen3-embedding:4b', 1024, { EMBED_MODEL: 'nomic-embed-text', EMBED_DIM: '768' })
    expect(typeof e.embed).toBe('function')
  })

  it('throws (registry config error) on an unknown model', () => {
    expect(() => makeEmbedderForPin('bogus-model', 768, {})).toThrow(/Unknown EMBED_MODEL|bogus-model/)
  })

  it('throws on an unsupported dim for the model', () => {
    expect(() => makeEmbedderForPin('nomic-embed-text', 999, {})).toThrow(/not valid|Allowed/)
  })
})
