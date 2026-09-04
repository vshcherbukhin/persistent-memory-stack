/**
 * Provider-agnostic batching + retry/backoff + a classifying fetch helper.
 * Reused by all three embedder implementations.
 */
import type { ProviderName } from '../types/index.ts'
import { EmbeddingError } from '../types/index.ts'

/** Split items into fixed-size batches, preserving order. */
export function* chunkBatches<T>(items: T[], size: number): Generator<T[]> {
  const step = size > 0 ? size : items.length || 1
  for (let i = 0; i < items.length; i += step) yield items.slice(i, i + step)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Exponential backoff with full jitter. Retries ONLY transient classes
 * (rate_limit, timeout, network, 5xx http). Honors Retry-After when the provider
 * set `retryAfterMs` on the error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; provider: ProviderName; model: string },
): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      const retriable =
        e instanceof EmbeddingError &&
        (e.meta.kind === 'rate_limit' ||
          e.meta.kind === 'timeout' ||
          e.meta.kind === 'network' ||
          (e.meta.kind === 'http' && (e.meta.status ?? 0) >= 500))
      if (!retriable || attempt >= opts.maxRetries) throw e
      const base = Math.min(1000 * 2 ** attempt, 16000)
      const jittered = Math.random() * base // full jitter
      const explicit =
        e instanceof EmbeddingError ? e.retryAfterMs : undefined
      await sleep(explicit ?? jittered)
      attempt++
    }
  }
}

/**
 * POST JSON to a provider endpoint with an AbortController deadline. Classifies
 * non-2xx into auth/rate_limit/http and network failures into 'network'/'timeout'.
 * Parses Retry-After (seconds or HTTP-date) onto the thrown error for backoff.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  ctx: { provider: ProviderName; model: string; timeoutMs: number },
): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ctx.timeoutMs)
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (cause) {
    clearTimeout(timer)
    const aborted = cause instanceof Error && cause.name === 'AbortError'
    throw new EmbeddingError(
      aborted
        ? `Embedding request to ${ctx.provider} timed out after ${ctx.timeoutMs}ms (${url}).`
        : `Network error reaching ${ctx.provider} at ${url}: ${String(cause)}. ` +
          (ctx.provider === 'ollama'
            ? `Is \`ollama serve\` running and is "${ctx.model}" pulled (\`ollama pull ${ctx.model}\`)?`
            : 'Check connectivity / DNS.'),
      {
        provider: ctx.provider,
        model: ctx.model,
        kind: aborted ? 'timeout' : 'network',
        cause,
      },
    )
  }
  clearTimeout(timer)

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    const kind =
      res.status === 401 || res.status === 403
        ? 'auth'
        : res.status === 429
          ? 'rate_limit'
          : 'http'
    const err = new EmbeddingError(
      `${ctx.provider} returned HTTP ${res.status} for "${ctx.model}": ${bodyText.slice(0, 400)}`,
      { provider: ctx.provider, model: ctx.model, kind, status: res.status },
    )
    const ra = res.headers.get('retry-after')
    if (ra) {
      const secs = Number(ra)
      err.retryAfterMs = Number.isFinite(secs)
        ? secs * 1000
        : Math.max(0, Date.parse(ra) - Date.now())
    }
    throw err
  }

  try {
    return await res.json()
  } catch (cause) {
    throw new EmbeddingError(
      `${ctx.provider} returned a non-JSON body for "${ctx.model}".`,
      { provider: ctx.provider, model: ctx.model, kind: 'shape', cause },
    )
  }
}

/** Throw dim_mismatch if any vector's length != expected. Belt-and-suspenders. */
export function assertDim(
  vectors: number[][],
  dim: number,
  provider: ProviderName,
  model: string,
): void {
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i]
    if (!Array.isArray(v) || v.length !== dim) {
      throw new EmbeddingError(
        `${provider} "${model}" returned a vector of length ${v?.length} at index ${i}, ` +
          `expected ${dim}. The truncation param may be unsupported or the registry is stale.`,
        { provider, model, kind: 'dim_mismatch' },
      )
    }
  }
}
