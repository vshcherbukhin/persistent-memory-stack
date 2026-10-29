import { MODEL_REGISTRY } from '@pm/shared'
import type { EffectiveSettings } from './settings.ts'

export type DashboardEmbeddingSettings = Pick<EffectiveSettings, 'embeddingMode' | 'activeEmbedModel'> & Partial<Pick<EffectiveSettings, 'activeEmbedDim'>>

/**
 * Only server-managed Ollama embeddings depend on this API host. Client-managed
 * embeddings run on their own client, while fact extraction uses API providers.
 */
export function dashboardOllamaTarget(settings: DashboardEmbeddingSettings): { provider: 'ollama'; model: string; dim: number } | null {
  if (settings.embeddingMode === 'client-bridge' || MODEL_REGISTRY[settings.activeEmbedModel]?.provider !== 'ollama') {
    return null
  }
  return { provider: 'ollama', model: settings.activeEmbedModel, dim: settings.activeEmbedDim ?? MODEL_REGISTRY[settings.activeEmbedModel]!.nativeDim }
}
