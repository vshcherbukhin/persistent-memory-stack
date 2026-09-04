import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import type { ProviderName } from '@pm/shared'
import { recordClientEmbeddingObservation } from '../services/embedding-health.ts'

const Provider = z.enum(['ollama', 'voyage', 'openai'])
const FailureCode = z.enum([
  'embedding_quota_exhausted',
  'embedding_provider_rate_limited',
  'embedding_provider_unavailable',
  'embedding_model_unavailable',
  'embedding_timeout',
])
const Observation = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), code: FailureCode }).strict(),
])
const Body = z.object({ provider: Provider, model: z.string().min(1), outcome: Observation }).strict()

/** The API owns the client observer identity; MCP callers cannot forge another scope. */
export function clientEmbeddingHealthTarget(
  identity: { userId: string },
  input: { provider: ProviderName; model: string },
): { observerScope: `client:${string}`; provider: ProviderName; model: string } {
  return {
    observerScope: `client:${identity.userId}`,
    provider: input.provider,
    model: input.model,
  }
}

/** Authenticated MCP/client bridge observations, scoped to the authenticated user. */
export async function embeddingHealthRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()
  z4.post(
    '/embedding-health/observation',
    { schema: { body: Body, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const target = clientEmbeddingHealthTarget(req.identity!, req.body)
      await recordClientEmbeddingObservation(target, req.body.outcome)
      return { ok: true as const }
    },
  )
}
