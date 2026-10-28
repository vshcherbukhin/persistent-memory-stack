import type { EffectiveSettings } from './settings.ts'
import { dashboardOllamaTarget, type DashboardEmbeddingSettings } from './dashboard-ollama.ts'
import { ollamaReadiness, type OllamaReadiness } from './ollama-readiness.ts'
import {
  modelDependencyHealth,
  type SafeModelDependencyHealthDto,
} from './model-dependency-health.ts'

export type DashboardCapabilityHealth = {
  factExtraction: SafeModelDependencyHealthDto
  embeddings: SafeModelDependencyHealthDto
  ollamaHost: SafeModelDependencyHealthDto
}

export function dashboardEmbeddingObserverScope(
  settings: Pick<EffectiveSettings, 'embeddingMode'>,
  userId: string,
): 'server' | `client:${string}` {
  return settings.embeddingMode === 'client-bridge' ? `client:${userId}` : 'server'
}

function unknownCapabilityHealth(
  capability: SafeModelDependencyHealthDto['capability'],
  observerScope: string,
): SafeModelDependencyHealthDto {
  return {
    capability,
    observerScope,
    state: 'unknown',
    provider: null,
    model: null,
    lastSuccessAt: null,
    firstFailureAt: null,
    lastFailureAt: null,
    failureCode: null,
    safeMessage: null,
    retryable: null,
    consecutiveFailures: 0,
    observedAt: null,
    updatedAt: null,
  }
}

async function readSafeHealth(
  capability: SafeModelDependencyHealthDto['capability'],
  observerScope: string,
): Promise<SafeModelDependencyHealthDto> {
  try {
    return await modelDependencyHealth.getSafeHealth(capability, observerScope)
  } catch {
    // A missing/new migration must never block dashboard operational reads.
    return unknownCapabilityHealth(capability, observerScope)
  }
}

/**
 * Return only canonical health records for the current dashboard identity. In a
 * client-managed install, an embedding observation belongs to one MCP/client;
 * never project another user's record as a stack-wide failure.
 */
export async function getDashboardCapabilityHealth(
  settings: DashboardEmbeddingSettings,
  userId: string,
): Promise<DashboardCapabilityHealth> {
  const embeddingScope = dashboardEmbeddingObserverScope(settings, userId)
  const target = dashboardOllamaTarget(settings)
  const [factExtraction, embeddings, ollamaHost, readiness] = await Promise.all([
    readSafeHealth('fact_extraction', 'server'),
    readSafeHealth('embeddings', embeddingScope),
    target
      ? readSafeHealth('ollama_host', 'host')
      : unknownCapabilityHealth('ollama_host', 'host'),
    target ? ollamaReadiness.inspect(target) : null,
  ])
  return { factExtraction, embeddings: target && readiness ? withOllamaReadiness(embeddings, target.model, readiness) : embeddings,
    ollamaHost: target && readiness ? withOllamaReadiness(ollamaHost, target.model, readiness) : ollamaHost }
}

/** Current readiness supersedes historical success. Keep newer request failures. */
export function withOllamaReadiness(health: SafeModelDependencyHealthDto, model: string, readiness: OllamaReadiness): SafeModelDependencyHealthDto {
  if (readiness.state === 'ready' && health.model === model && health.observedAt && readiness.readyAt && health.observedAt > readiness.readyAt) return health
  const ready = readiness.state === 'ready'
  const starting = readiness.state === 'starting'
  return { ...health, state: ready ? 'healthy' : starting ? 'starting' : 'unhealthy', provider: 'ollama', model,
    lastSuccessAt: ready ? readiness.readyAt : health.lastSuccessAt,
    failureCode: ready ? null : starting ? 'embeddings_starting' : readiness.state === 'unavailable' ? 'embedding_provider_unavailable' : 'embedding_model_unavailable',
    safeMessage: ready ? null : readiness.message, retryable: ready ? null : starting || readiness.state === 'unavailable',
    observedAt: readiness.observedAt, updatedAt: readiness.observedAt,
  }
}
