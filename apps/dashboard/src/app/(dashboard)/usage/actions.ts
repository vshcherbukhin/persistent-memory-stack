'use server'

import { api, ApiError } from '@/lib/api'
import { requireSession } from '@/lib/session'
import type { DashboardCapabilityHealth, MemorySurface, ModelDependencyHealth, UsageResponse, UsageWindow } from '@/lib/types'

const unknownHealth = (capability: ModelDependencyHealth['capability'], observerScope: string): ModelDependencyHealth => ({
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
})
const EMPTY_HEALTH: DashboardCapabilityHealth = {
  factExtraction: unknownHealth('fact_extraction', 'server'),
  embeddings: unknownHealth('embeddings', 'server'),
  ollamaHost: unknownHealth('ollama_host', 'host'),
}
const EMPTY: UsageResponse = { window: '', totals: { tokens: 0, requests: 0, cost: 0 }, rows: [], trend: [], users: [], capabilityHealth: EMPTY_HEALTH }

/**
 * Model-usage metrics for the Usage page. Org-wide reads viewable by ANY
 * authenticated user (the design shows Usage to members too). Errors → empty + message.
 */
export async function getUsageAction(window: UsageWindow, surface: MemorySurface = 'personal'): Promise<UsageResponse & { error?: string }> {
  await requireSession()
  try {
    return await api.getUsage(window, surface)
  } catch (err) {
    if (err instanceof ApiError) return { ...EMPTY, window, error: err.message }
    throw err
  }
}
