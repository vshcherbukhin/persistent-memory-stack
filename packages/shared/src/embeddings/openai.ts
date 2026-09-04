/**
 * OpenAI embedder (opt-in cloud).
 *
 * Endpoint: POST https://api.openai.com/v1/embeddings, Bearer OPENAI_API_KEY.
 *   • `dimensions` (singular — vs Voyage's output_dimension) truncates
 *     text-embedding-3-* (Matryoshka, any size ≤ native). Only sent below native.
 *   • encoding_format pinned to "float" (base64 would need decoding).
 *   • Response data[] carries `index`; reorder defensively.
 *   • 401/403 → auth (no retry); 429 → rate_limit (retry w/ backoff + Retry-After).
 */
import type { EmbedKind } from '../types/index.ts'
import type { Embedder, EmbedResult } from './embedder.ts'
import type { EmbedConfig } from './config.ts'
import type { ModelSpec } from './registry.ts'
import { assertDim, chunkBatches, fetchJson, withRetry } from './batch.ts'
import { shapeErr } from '../types/index.ts'
import { vectorName } from './naming.ts'
import { emitEmbedUsage, estimateTokens } from './usage-sink.ts'

export class OpenAIEmbedder implements Embedder {
  readonly provider = 'openai' as const
  readonly model: string
  readonly dim: number
  readonly vectorName: string

  constructor(
    private readonly cfg: EmbedConfig,
    private readonly spec: ModelSpec,
  ) {
    this.model = cfg.model
    this.dim = cfg.dim
    this.vectorName = vectorName(cfg.model, cfg.dim)
  }

  async embed(texts: string[], _kind: EmbedKind = 'document'): Promise<EmbedResult> {
    const out: number[][] = []
    for (const batch of chunkBatches(texts, this.cfg.batchSize)) {
      const vecs = await withRetry(() => this.call(batch), {
        maxRetries: this.cfg.maxRetries,
        provider: 'openai',
        model: this.model,
      })
      out.push(...vecs)
    }
    assertDim(out, this.dim, 'openai', this.model)
    emitEmbedUsage({ provider: this.provider, model: this.model, tokens: estimateTokens(texts) })
    return { vectors: out, model: this.model, dim: this.dim }
  }

  private async call(batch: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: batch,
      encoding_format: 'float',
    }
    if (this.dim !== this.spec.nativeDim) body.dimensions = this.dim
    const json = (await fetchJson(
      'https://api.openai.com/v1/embeddings',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.openaiApiKey ?? ''}` },
        body: JSON.stringify(body),
      },
      { provider: 'openai', model: this.model, timeoutMs: this.cfg.requestTimeoutMs },
    )) as { data?: Array<{ embedding: number[]; index: number }> }

    const data = json.data
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw shapeErr('openai', this.model, `Expected ${batch.length} embeddings, got ${data?.length}.`)
    }
    const ordered = new Array<number[]>(batch.length)
    for (const d of data) ordered[d.index] = d.embedding
    return ordered
  }
}
