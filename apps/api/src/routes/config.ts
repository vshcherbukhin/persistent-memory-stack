/**
 * GET /config — the EFFECTIVE embedding topology + active pin (Phase 8).
 *
 * The persistent-memory-mcp reads this at startup to decide the embedding
 * topology and, for client-managed embeddings, build the local embedder at the
 * server-pinned model/dim. The MCP must
 * NOT trust its own EMBEDDING_MODE env — the mode is admin-toggleable at runtime
 * (P9 System Settings), so the API is the source of truth.
 *
 * Registered OUTSIDE the secured scope (public, like /health): the values leak
 * nothing sensitive (only the active model id, dim, named-vector key, and mode),
 * and the MCP needs them before it has authenticated anything.
 *
 * P9 CHANGE: it now reads the SystemSettings singleton via getEffectiveSettings()
 * and FALLS BACK to the env-derived boot pin when the row is absent. The admin
 * panel writes the topology and pin into that row, so the MCP (which trusts
 * /config, not its own env) sees the change on its next startup. The fallback is
 * mandatory — a fresh DB before the seed upsert must return env defaults, never
 * a 500.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { getEffectiveSettings } from '../services/settings.ts'
import { config } from '../config.ts'

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/config',
    {
      schema: {
        response: {
          200: z.object({
            embeddingTopology: z.enum(['server-managed-embeddings', 'client-managed-embeddings']),
            /** Deprecated compatibility alias. Prefer embeddingTopology. */
            embeddingMode: z.enum(['server', 'client-bridge']),
            activeModel: z.string(),
            activeDim: z.number().int().positive(),
            activeVectorName: z.string(),
            // Deploy-time topology (Phase 13). Read-only telemetry — the auth-skip
            // decision is keyed off the api/dashboard service's OWN env, not this value.
            deploymentMode: z.enum(['server', 'local']),
            /** True only for the disposable Docker integration stack. */
            testStack: z.boolean(),
            dashboardLoginMode: z.enum(['password', 'sso']),
            mcpSessionIdleTimeoutSeconds: z.number().int().min(0),
          }),
        },
      },
    },
    async () => {
      const s = await getEffectiveSettings()
      return {
        embeddingTopology: s.embeddingTopology,
        embeddingMode: s.embeddingMode,
        activeModel: s.activeEmbedModel,
        activeDim: s.activeEmbedDim,
        activeVectorName: s.activeVectorName,
        deploymentMode: config.DEPLOYMENT_MODE,
        testStack: config.PM_TEST_STACK,
        dashboardLoginMode: s.dashboardLoginMode,
        mcpSessionIdleTimeoutSeconds: s.mcpSessionIdleTimeoutSeconds,
      }
    },
  )
}
