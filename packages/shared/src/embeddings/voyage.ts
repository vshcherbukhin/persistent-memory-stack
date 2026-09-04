/**
 * Voyage embedder (opt-in cloud, ASYMMETRIC).
 *
 * Endpoint: POST https://api.voyageai.com/v1/embeddings, Bearer VOYAGE_API_KEY.
 *   • input_type matters for quality: 'document' for stored chunks/memories,
 *     'query' for the search query. Voyage prepends different instruction
 *     prefixes per type; mixing degrades recall — this is THE reason `kind` is
 *     in the Embedder interface.
 *   • Dimension param is `output_dimension` (NOT `dimensions`).
 *   • Response data[] carries an `index`; reorder by it (order not guaranteed).
 *   • Input array cap 1000 (default batchSize 128).
 */
import type { EmbedKind } from '../types/index.ts'
import type { Embedder, EmbedResult } from './embedder.ts'
import type { EmbedConfig } from './config.ts'
import type { ModelSpec } from './registry.ts'
import { assertDim, chunkBatches, fetchJson, withRetry } from './batch.ts'
import { shapeErr } from '../types/index.ts'
import { vectorName } from './naming.ts'
import { emitEmbedUsage, estimateTokens } from './usage-sink.ts'

export class VoyageEmbedder implements Embedder {
  readonly provider = 'voyage' as const
  readonly model: string
  readonly dim: number
  readonly vectorName: string

  constructor(
    private readonly cfg: EmbedConfig,
    _spec: ModelSpec,
  ) {
    this.model = cfg.model
    this.dim = cfg.dim
    this.vectorName = vectorName(cfg.model, cfg.dim)
  }

  async embed(texts: string[], kind: EmbedKind = 'document'): Promise<EmbedResult> {
    const out: number[][] = []
    for (const batch of chunkBatches(texts, this.cfg.batchSize)) {
      const vecs = await withRetry(() => this.call(batch, kind), {
        maxRetries: this.cfg.maxRetries,
        provider: 'voyage',
        model: this.model,
      })
      out.push(...vecs)
    }
    assertDim(out, this.dim, 'voyage', this.model)
    emitEmbedUsage({ provider: this.provider, model: this.model, tokens: estimateTokens(texts) })
    return { vectors: out, model: this.model, dim: this.dim }
  }

  private async call(batch: string[], kind: EmbedKind): Promise<number[][]> {
    const json = (await fetchJson(
      'https://api.voyageai.com/v1/embeddings',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.voyageApiKey ?? ''}` },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          input_type: kind, // 'document' | 'query'
          output_dimension: this.dim,
          truncation: true,
        }),
      },
      { provider: 'voyage', model: this.model, timeoutMs: this.cfg.requestTimeoutMs },
    )) as { data?: Array<{ embedding: number[]; index: number }> }

    const data = json.data
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw shapeErr('voyage', this.model, `Expected ${batch.length} embeddings, got ${data?.length}.`)
    }
    const ordered = new Array<number[]>(batch.length)
    for (const d of data) ordered[d.index] = d.embedding // reorder by index
    return ordered
  }
}
