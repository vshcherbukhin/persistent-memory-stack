/** Installer-only model catalog: works before the shared package is built.
 * A parity test checks this against the runtime registry. */
export type EmbeddingProvider = 'ollama' | 'openai' | 'voyage'
export interface EmbeddingSelection { provider: EmbeddingProvider; model: string; dim: number }
export interface EmbeddingModelSpec { provider: EmbeddingProvider; nativeDim: number; supportedDims?: readonly number[] }

export const EMBEDDING_MODELS: Readonly<Record<string, EmbeddingModelSpec>> = {
  'qwen3-embedding:0.6b': { provider: 'ollama', nativeDim: 1024, supportedDims: [1024, 768, 512, 256] },
  'qwen3-embedding:4b': { provider: 'ollama', nativeDim: 2560, supportedDims: [2560, 1024, 768, 512, 256] },
  'qwen3-embedding:8b': { provider: 'ollama', nativeDim: 4096, supportedDims: [4096, 2560, 1024, 768, 512, 256] },
  'nomic-embed-text': { provider: 'ollama', nativeDim: 768, supportedDims: [768] },
  'voyage-3-large': { provider: 'voyage', nativeDim: 1024, supportedDims: [256, 512, 1024, 2048] },
  'voyage-4': { provider: 'voyage', nativeDim: 1024, supportedDims: [256, 512, 1024, 2048] },
  'voyage-4-large': { provider: 'voyage', nativeDim: 1024, supportedDims: [256, 512, 1024, 2048] },
  'voyage-4-lite': { provider: 'voyage', nativeDim: 1024, supportedDims: [256, 512, 1024, 2048] },
  'text-embedding-3-small': { provider: 'openai', nativeDim: 1536 },
  'text-embedding-3-large': { provider: 'openai', nativeDim: 3072 },
}

export function validateEmbeddingSelection(input: Partial<EmbeddingSelection>): string | null {
  if (!['ollama', 'openai', 'voyage'].includes(input.provider ?? '')) return 'Choose a supported embedding provider: Ollama, OpenAI, or Voyage.'
  const spec = typeof input.model === 'string' ? EMBEDDING_MODELS[input.model] : undefined
  if (!spec || spec.provider !== input.provider) return 'Choose a supported embedding model for the selected provider.'
  if (!Number.isInteger(input.dim) || !input.dim || (spec.supportedDims ? !spec.supportedDims.includes(input.dim) : input.dim < 1 || input.dim > spec.nativeDim)) {
    return `Embedding dimensions for ${input.model} must be ${spec.supportedDims?.join(', ') ?? `an integer from 1 to ${spec.nativeDim}`}.`
  }
  return null
}

export function readEmbeddingSelection(env: Readonly<Record<string, string | undefined>>): EmbeddingSelection | null {
  const selection = { provider: env.EMBED_PROVIDER as EmbeddingProvider, model: env.EMBED_MODEL ?? '', dim: Number(env.EMBED_DIM) }
  return validateEmbeddingSelection(selection) ? null : selection
}
