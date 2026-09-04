/**
 * The Embedder interface + EmbedResult. Deliberately tiny: one method, plain
 * number[][] in/out. Order-preserving. The client-managed precomputed-vector dim guard
 * lives in the Qdrant layer, not here — the adapter only PRODUCES pinned-model
 * vectors by construction (server-managed embeddings).
 */
import type { EmbedKind, ProviderName } from '../types/index.ts'

export interface EmbedResult {
  /** One vector per input, in input order. */
  vectors: number[][]
  /** Resolved model id, e.g. "qwen3-embedding:0.6b". */
  model: string
  /** Produced dimension (== config.dim). */
  dim: number
}

export interface Embedder {
  readonly provider: ProviderName
  readonly model: string
  readonly dim: number
  /** Stable Qdrant named-vector key for this (model, dim): "<slug>__<dim>". */
  readonly vectorName: string
  /** Batches, retries, and validates the produced dim. kind defaults to 'document'. */
  embed(texts: string[], kind?: EmbedKind): Promise<EmbedResult>
}
