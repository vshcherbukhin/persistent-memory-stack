import type { EffectiveSettings } from './settings.ts'
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
  settings: Pick<EffectiveSettings, 'embeddingMode'>,
  userId: string,
): Promise<DashboardCapabilityHealth> {
  const embeddingScope = dashboardEmbeddingObserverScope(settings, userId)
  const [factExtraction, embeddings, ollamaHost] = await Promise.all([
    readSafeHealth('fact_extraction', 'server'),
    readSafeHealth('embeddings', embeddingScope),
    readSafeHealth('ollama_host', 'host'),
  ])
  return { factExtraction, embeddings, ollamaHost }
}
