/**
 * Ollama embedder (default). Local CPU/Metal via OLLAMA_URL.
 *
 * Endpoint: POST {OLLAMA_URL}/api/embed  (the MODERN plural endpoint).
 *   • Accepts a STRING ARRAY in one call → { embeddings: number[][] }.
 *   • The legacy /api/embeddings is singular-input (returns `embedding`) — the
 *     classic foot-gun; we never use it.
 *   • `dimensions` truncation only sent when reducing below native AND the model
 *     supports it (qwen3); nomic is fixed 768 (registry gate prevents sending it).
 *   • keep_alive keeps the model warm so the next batch skips the cold-load.
 */
import type { EmbedKind } from '../types/index.ts'
import type { Embedder, EmbedResult } from './embedder.ts'
import type { EmbedConfig } from './config.ts'
import type { ModelSpec } from './registry.ts'
import { assertDim, chunkBatches, fetchJson, withRetry } from './batch.ts'
import { shapeErr } from '../types/index.ts'
import { vectorName } from './naming.ts'
import { emitEmbedUsage, estimateTokens } from './usage-sink.ts'

export class OllamaEmbedder implements Embedder {
  readonly provider = 'ollama' as const
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
        provider: 'ollama',
        model: this.model,
      })
      out.push(...vecs)
    }
    assertDim(out, this.dim, 'ollama', this.model)
    emitEmbedUsage({ provider: this.provider, model: this.model, tokens: estimateTokens(texts) })
    return { vectors: out, model: this.model, dim: this.dim }
  }

  private async call(batch: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: batch,
      truncate: true,
      keep_alive: '5m',
    }
    // Only send `dimensions` when truncating AND the model supports it.
    if (
      this.spec.supportedDims &&
      this.spec.supportedDims.length > 1 &&
      this.dim !== this.spec.nativeDim
    ) {
      body.dimensions = this.dim
    }
    const json = (await fetchJson(
      `${this.cfg.ollamaUrl.replace(/\/$/, '')}/api/embed`,
      { method: 'POST', body: JSON.stringify(body) },
      { provider: 'ollama', model: this.model, timeoutMs: this.cfg.requestTimeoutMs },
    )) as { embeddings?: number[][] }
    const embs = json.embeddings
    if (!Array.isArray(embs) || embs.length !== batch.length) {
      throw shapeErr(
        'ollama',
        this.model,
        `Expected ${batch.length} embeddings, got ${embs?.length}. ` +
          `If "${this.model}" is not pulled, run \`ollama pull ${this.model}\` on the host at ${this.cfg.ollamaUrl}.`,
      )
    }
    return embs
  }
}
