import { ownerPrisma } from '@pm/db'
import { EmbeddingError, type ProviderName } from '@pm/shared'

export type WorkerEmbeddingFailure = {
  code: 'embedding_quota_exhausted' | 'embedding_provider_rate_limited' | 'embedding_provider_unavailable' | 'embedding_model_unavailable' | 'embedding_timeout'
  state: 'degraded' | 'unhealthy'
}

export type WorkerEmbeddingObservation = {
  capability: 'embeddings'
  observerScope: 'server'
  provider: ProviderName
  model: string
} & ({ success: true } | { failure: WorkerEmbeddingFailure })

type WorkerEmbedder = { provider: ProviderName; model: string }
type HealthRecord = {
  capability: 'embeddings'
  observerScope: 'server'
  state: 'healthy' | 'degraded' | 'unhealthy'
  provider: ProviderName | null
  model: string | null
  lastSuccessAt: Date | null
  firstFailureAt: Date | null
  lastFailureAt: Date | null
  failureCode: string | null
  safeMessage: string | null
  retryable: boolean | null
  consecutiveFailures: number
  observedAt: Date
  updatedAt: Date
}

type HealthRepository = {
  findUnique(args: { where: { capability_observerScope: { capability: 'embeddings'; observerScope: 'server' } } }): Promise<HealthRecord | null>
  upsert(args: { where: { capability_observerScope: { capability: 'embeddings'; observerScope: 'server' } }; create: HealthRecord; update: Record<string, never> }): Promise<HealthRecord>
  updateMany(args: { where: { capability: 'embeddings'; observerScope: 'server'; observedAt: { lte: Date } }; data: HealthRecord }): Promise<{ count: number }>
}

const policy = {
  embedding_quota_exhausted: { state: 'unhealthy' as const, message: 'Embeddings are out of tokens.', retryable: false },
  embedding_provider_rate_limited: { state: 'degraded' as const, message: 'Embedding provider is rate-limited. Retry shortly.', retryable: true },
  embedding_provider_unavailable: { state: 'unhealthy' as const, message: 'Embeddings are unavailable.', retryable: true },
  embedding_model_unavailable: { state: 'unhealthy' as const, message: 'Configured embedding model is unavailable.', retryable: false },
  embedding_timeout: { state: 'degraded' as const, message: 'Embedding provider timed out. Retry shortly.', retryable: true },
}

function classify(error: unknown): WorkerEmbeddingFailure {
  if (error instanceof EmbeddingError) {
    const status = error.meta.status
    if (status === 402 || /\b(quota|tokens?|credits?|billing|budget)\b/i.test(error.message)) return { code: 'embedding_quota_exhausted', state: 'unhealthy' }
    if (error.meta.kind === 'rate_limit' || status === 429) return { code: 'embedding_provider_rate_limited', state: 'degraded' }
    if (error.meta.kind === 'timeout') return { code: 'embedding_timeout', state: 'degraded' }
    if (error.meta.kind === 'config' || error.meta.kind === 'dim_mismatch' || status === 404 || /\b(not pulled|model.+not found|unknown model)\b/i.test(error.message)) {
      return { code: 'embedding_model_unavailable', state: 'unhealthy' }
    }
  }
  return { code: 'embedding_provider_unavailable', state: 'unhealthy' }
}

/**
 * Persist the worker's server-scoped observation with the same timestamp guard as
 * the API health service. Failures here are diagnostic only and never mask a job.
 */
export async function recordWorkerEmbeddingHealth(observation: WorkerEmbeddingObservation): Promise<void> {
  try {
    const repository = (ownerPrisma as unknown as { modelDependencyHealth: HealthRepository }).modelDependencyHealth
    const key = { capability: 'embeddings' as const, observerScope: 'server' as const }
    const observedAt = new Date()
    const existing = await repository.findUnique({ where: { capability_observerScope: key } })
    if (existing && existing.observedAt > observedAt) return

    const next = 'success' in observation
      ? {
          ...key, state: 'healthy' as const, provider: observation.provider, model: observation.model,
          lastSuccessAt: observedAt, firstFailureAt: null, lastFailureAt: null,
          failureCode: null, safeMessage: null, retryable: null, consecutiveFailures: 0,
          observedAt, updatedAt: observedAt,
        }
      : (() => {
          const selected = policy[observation.failure.code]
          return {
            ...key, state: selected.state, provider: observation.provider, model: observation.model,
            lastSuccessAt: existing?.lastSuccessAt ?? null,
            firstFailureAt: existing?.state === 'healthy' ? observedAt : existing?.firstFailureAt ?? observedAt,
            lastFailureAt: observedAt, failureCode: observation.failure.code, safeMessage: selected.message,
            retryable: selected.retryable,
            consecutiveFailures: existing?.state === 'healthy' ? 1 : (existing?.consecutiveFailures ?? 0) + 1,
            observedAt, updatedAt: observedAt,
          }
        })()

    const reserved = await repository.upsert({ where: { capability_observerScope: key }, create: next, update: {} })
    if (reserved.observedAt > observedAt || (!existing && reserved.observedAt.getTime() === observedAt.getTime())) return
    await repository.updateMany({ where: { ...key, observedAt: { lte: observedAt } }, data: next })
  } catch {
    // The original embedding result/error remains authoritative when telemetry fails.
  }
}

/** Run an actual worker embedding call while reporting only canonical health. */
export async function withWorkerEmbeddingHealth<T>(
  embedder: WorkerEmbedder,
  operation: () => Promise<T>,
  record: (observation: WorkerEmbeddingObservation) => Promise<void> = recordWorkerEmbeddingHealth,
): Promise<T> {
  try {
    const result = await operation()
    await record({ capability: 'embeddings', observerScope: 'server', provider: embedder.provider, model: embedder.model, success: true }).catch(() => {})
    return result
  } catch (error) {
    await record({ capability: 'embeddings', observerScope: 'server', provider: embedder.provider, model: embedder.model, failure: classify(error) }).catch(() => {})
    throw error
  }
}
