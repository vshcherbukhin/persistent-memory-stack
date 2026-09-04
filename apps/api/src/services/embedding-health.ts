import { EmbeddingError, type ProviderName } from '@pm/shared'
import { modelDependencyHealth, type ModelDependencyFailureCode } from './model-dependency-health.ts'

type EmbeddingFailureCode = Extract<ModelDependencyFailureCode,
  | 'embedding_quota_exhausted'
  | 'embedding_provider_rate_limited'
  | 'embedding_provider_unavailable'
  | 'embedding_model_unavailable'
  | 'embedding_timeout'
>

type EmbeddingFailure = {
  code: EmbeddingFailureCode
  state: 'degraded' | 'unhealthy'
  message: string
  retryable: boolean
}

export type EmbeddingHealthTarget = {
  observerScope: 'server' | `client:${string}`
  provider: ProviderName
  model: string
}

/** Safe error exposed at API boundaries; never includes upstream response text. */
export class EmbeddingProviderError extends Error {
  readonly statusCode = 503 as const

  constructor(
    readonly code: EmbeddingFailureCode,
    message: string,
    readonly provider: ProviderName,
    readonly model: string,
    readonly retryable: boolean,
    readonly upstreamStatus?: number,
  ) {
    super(message)
    this.name = 'EmbeddingProviderError'
  }

  toLogFields(): Record<string, string | number | boolean | undefined> {
    return {
      code: this.code,
      provider: this.provider,
      model: this.model,
      retryable: this.retryable,
      upstreamStatus: this.upstreamStatus,
    }
  }
}

/** A successful HTTP request with the wrong vector width is a failed probe. */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(actual: number, expected: number) {
    super(`Embedding returned ${actual} dimensions, expected ${expected}.`)
    this.name = 'EmbeddingDimensionMismatchError'
  }
}

function failureFromEmbeddingError(error: EmbeddingError): EmbeddingFailure {
  const status = error.meta.status
  const raw = error.message
  if (status === 402 || /\b(quota|tokens?|credits?|billing|budget)\b/i.test(raw)) {
    return { code: 'embedding_quota_exhausted', state: 'unhealthy', message: 'Embeddings are out of tokens.', retryable: false }
  }
  if (error.meta.kind === 'rate_limit' || status === 429) {
    return { code: 'embedding_provider_rate_limited', state: 'degraded', message: 'Embedding provider is rate-limited. Retry shortly.', retryable: true }
  }
  if (error.meta.kind === 'timeout') {
    return { code: 'embedding_timeout', state: 'degraded', message: 'Embedding provider timed out. Retry shortly.', retryable: true }
  }
  if (error.meta.kind === 'config' || error.meta.kind === 'dim_mismatch' || status === 404 || /\b(not pulled|model.+not found|unknown model)\b/i.test(raw)) {
    return { code: 'embedding_model_unavailable', state: 'unhealthy', message: 'Configured embedding model is unavailable.', retryable: false }
  }
  return { code: 'embedding_provider_unavailable', state: 'unhealthy', message: 'Embeddings are unavailable.', retryable: true }
}

export function toEmbeddingProviderError(error: unknown, target: EmbeddingHealthTarget): EmbeddingProviderError {
  if (error instanceof EmbeddingProviderError) return error
  if (error instanceof EmbeddingDimensionMismatchError) {
    return new EmbeddingProviderError(
      'embedding_model_unavailable',
      error.message,
      target.provider,
      target.model,
      false,
    )
  }
  const classified = error instanceof EmbeddingError
    ? failureFromEmbeddingError(error)
    : { code: 'embedding_provider_unavailable' as const, state: 'unhealthy' as const, message: 'Embeddings are unavailable.', retryable: true }
  const upstreamStatus = error instanceof EmbeddingError ? error.meta.status : undefined
  return new EmbeddingProviderError(
    classified.code,
    classified.message,
    target.provider,
    target.model,
    classified.retryable,
    upstreamStatus,
  )
}

async function recordSuccess(target: EmbeddingHealthTarget): Promise<void> {
  try {
    await modelDependencyHealth.recordSuccess({
      capability: 'embeddings',
      observerScope: target.observerScope,
      provider: target.provider,
      model: target.model,
      observedAt: new Date(),
    })
  } catch {
    // Health observations never change the outcome of an embedding operation.
  }
}

async function recordFailure(target: EmbeddingHealthTarget, error: EmbeddingProviderError): Promise<void> {
  try {
    await modelDependencyHealth.recordFailure({
      capability: 'embeddings',
      observerScope: target.observerScope,
      provider: target.provider,
      model: target.model,
      failure: {
        code: error.code,
        state: error.code === 'embedding_provider_rate_limited' || error.code === 'embedding_timeout'
          ? 'degraded'
          : 'unhealthy',
      },
      observedAt: new Date(),
    })
  } catch {
    // The normalized provider failure remains authoritative if telemetry fails.
  }
}

/**
 * Run one real embedding operation and persist only its canonical health outcome.
 * API callers receive a redacted, actionable provider error while worker callers
 * can rethrow their original error after separately recording the observation.
 */
export async function withEmbeddingHealth<T>(
  target: EmbeddingHealthTarget,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation()
    await recordSuccess(target)
    return result
  } catch (cause) {
    const error = toEmbeddingProviderError(cause, target)
    await recordFailure(target, error)
    throw error
  }
}

/** Record a client bridge result sent through the authenticated API boundary. */
export async function recordClientEmbeddingObservation(
  target: EmbeddingHealthTarget,
  outcome: { ok: true } | { ok: false; code: EmbeddingFailureCode },
): Promise<void> {
  if (outcome.ok) return recordSuccess(target)
  const policy = new EmbeddingProviderError(
    outcome.code,
    outcome.code === 'embedding_quota_exhausted'
      ? 'Embeddings are out of tokens.'
      : outcome.code === 'embedding_model_unavailable'
        ? 'Configured embedding model is unavailable.'
        : outcome.code === 'embedding_timeout'
          ? 'Embedding provider timed out. Retry shortly.'
          : outcome.code === 'embedding_provider_rate_limited'
            ? 'Embedding provider is rate-limited. Retry shortly.'
            : 'Embeddings are unavailable.',
    target.provider,
    target.model,
    outcome.code !== 'embedding_quota_exhausted' && outcome.code !== 'embedding_model_unavailable',
  )
  await recordFailure(target, policy)
}
