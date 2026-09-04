/**
 * Model → native-dim + capability registry. Single source of truth for
 * (provider, model, dim) validation at boot.
 *
 * Dims verified June 2026:
 *   • qwen3-embedding:0.6b — native 1024, Matryoshka truncation to 768/512/256.
 *   • qwen3-embedding:4b   — native 2560, truncation to 1024/768/512/256.
 *   • qwen3-embedding:8b   — native 4096, truncation to 2560/1024/768/512/256.
 *   • nomic-embed-text     — fixed 768 (NO truncation).
 *   • voyage-3-large       — native 1024, output_dimension ∈ {256,512,1024,2048}.
 *   • text-embedding-3-large — native 3072, `dimensions` truncation to ANY 1..3072.
 *   • text-embedding-3-small — native 1536, `dimensions` truncation to ANY 1..1536.
 *
 * `supportedDims` present  ⇒ discrete truncation buckets (qwen3, voyage).
 * `supportedDims` absent   ⇒ open range 1..nativeDim (OpenAI 3-* Matryoshka).
 * No `supportedDims` AND fixed (nomic) is expressed as supportedDims:[nativeDim].
 */
import type { ProviderName } from '../types/index.ts'
import { cfgErr } from '../types/index.ts'

export interface ModelSpec {
  provider: ProviderName
  nativeDim: number
  /** Discrete allowed dims. Omit ⇒ provider accepts any 1..nativeDim (OpenAI). */
  supportedDims?: number[]
  /** Needs input_type query/document (Voyage). */
  asymmetric?: boolean
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  // ── Ollama (local CPU/Metal) ───────────────────────────────────────────────
  'qwen3-embedding:0.6b': {
    provider: 'ollama',
    nativeDim: 1024,
    supportedDims: [1024, 768, 512, 256],
  },
  'qwen3-embedding:4b': {
    provider: 'ollama',
    nativeDim: 2560,
    supportedDims: [2560, 1024, 768, 512, 256],
  },
  'qwen3-embedding:8b': {
    provider: 'ollama',
    // Native 4096 (Qwen3-Embedding-8B). Confirm against the pulled Ollama model
    // before relying on it in production (registry "verified" discipline).
    nativeDim: 4096,
    supportedDims: [4096, 2560, 1024, 768, 512, 256],
  },
  'nomic-embed-text': {
    provider: 'ollama',
    nativeDim: 768,
    supportedDims: [768], // fixed — sending a `dimensions` param is invalid
  },

  // ── Voyage (cloud, asymmetric) ─────────────────────────────────────────────
  'voyage-3-large': {
    provider: 'voyage',
    nativeDim: 1024,
    supportedDims: [256, 512, 1024, 2048],
    asymmetric: true,
  },

  // ── OpenAI (cloud, Matryoshka open range) ──────────────────────────────────
  'text-embedding-3-large': { provider: 'openai', nativeDim: 3072 },
  'text-embedding-3-small': { provider: 'openai', nativeDim: 1536 },
}

/**
 * Validate (provider, model, dim). Throws EmbeddingError{kind:'config'} with an
 * actionable message on any mismatch. Returns the resolved spec on success.
 */
export function validateModelDim(
  provider: ProviderName,
  model: string,
  dim: number,
): ModelSpec {
  const spec = MODEL_REGISTRY[model]
  if (!spec) {
    throw cfgErr(
      provider,
      model,
      `Unknown EMBED_MODEL "${model}". Known models: ${Object.keys(MODEL_REGISTRY).join(', ')}.`,
    )
  }
  if (spec.provider !== provider) {
    throw cfgErr(
      provider,
      model,
      `EMBED_MODEL "${model}" belongs to provider "${spec.provider}", not EMBED_PROVIDER "${provider}". ` +
        `Set EMBED_PROVIDER=${spec.provider} or pick a "${provider}" model.`,
    )
  }
  const ok = spec.supportedDims
    ? spec.supportedDims.includes(dim)
    : dim >= 1 && dim <= spec.nativeDim
  if (!ok) {
    const allowed = spec.supportedDims
      ? spec.supportedDims.join('/')
      : `1..${spec.nativeDim}`
    // Targeted nudge for the most common operator mistake (fixed-dim model).
    const fixed =
      spec.supportedDims && spec.supportedDims.length === 1
        ? ` "${model}" is fixed at ${spec.nativeDim}; pick a different model for ${dim}.`
        : ''
    throw cfgErr(
      provider,
      model,
      `EMBED_DIM=${dim} is not valid for "${model}". Allowed: ${allowed}.${fixed}`,
    )
  }
  return spec
}
