import { z } from 'zod/v4'

export const SafeModelDependencyHealthSchema = z.object({
  capability: z.enum(['fact_extraction', 'embeddings', 'ollama_host']),
  observerScope: z.string(),
  state: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']),
  provider: z.enum(['anthropic', 'openai', 'ollama', 'voyage']).nullable(),
  model: z.string().nullable(),
  lastSuccessAt: z.date().nullable(),
  firstFailureAt: z.date().nullable(),
  lastFailureAt: z.date().nullable(),
  failureCode: z.string().nullable(),
  safeMessage: z.string().nullable(),
  retryable: z.boolean().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  observedAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
})

export const DashboardCapabilityHealthSchema = z.object({
  factExtraction: SafeModelDependencyHealthSchema,
  embeddings: SafeModelDependencyHealthSchema,
  ollamaHost: SafeModelDependencyHealthSchema,
})
