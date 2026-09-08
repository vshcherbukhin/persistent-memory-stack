import { MODEL_REGISTRY } from '@pm/shared'
import type { EffectiveSettings } from './settings.ts'

export type DashboardEmbeddingSettings = Pick<EffectiveSettings, 'embeddingMode' | 'activeEmbedModel'>

/**
 * Only server-managed Ollama embeddings depend on this API host. Client-managed
 * embeddings run on their own client, while fact extraction uses API providers.
 */
export function dashboardOllamaTarget(settings: DashboardEmbeddingSettings): { provider: 'ollama'; model: string } | null {
  if (settings.embeddingMode === 'client-bridge' || MODEL_REGISTRY[settings.activeEmbedModel]?.provider !== 'ollama') {
    return null
  }
  return { provider: 'ollama', model: settings.activeEmbedModel }
}
