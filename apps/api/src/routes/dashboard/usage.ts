/**
 * /dashboard/usage — model-usage metrics for the dashboard Usage page. Org-wide,
 * non-team-data reads viewable by ANY authenticated user (registered OUTSIDE the
 * requireAdmin scope — see dashboard/index.ts). Returns per-(service,model) rows + window
 * totals + an hourly trend + per-user request totals; the client groups into
 * by-service / by-model / by-user views.
 * Reads the control-plane rollup table via ownerPrisma (no RLS, no tenant tx).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { aggregateUsage } from '../../services/usage.ts'
import { getEffectiveSettings } from '../../services/settings.ts'
import { getDashboardCapabilityHealth } from '../../services/dashboard-capability-health.ts'
import { DashboardCapabilityHealthSchema } from './capability-health.ts'

const Row = z.object({
  service: z.string(),
  model: z.string(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  requests: z.number(),
  avgTokensPerReq: z.number(),
  rpm: z.number(),
  cost: z.number(),
  estimated: z.boolean(),
})
const Totals = z.object({ tokens: z.number(), requests: z.number(), cost: z.number() })
const Trend = z.object({ t: z.string(), tokens: z.number() })
const UserRow = z.object({
  userId: z.string().nullable(),
  displayName: z.string(),
  email: z.string().nullable(),
  tokens: z.number(),
  requests: z.number(),
})

export async function dashboardUsageRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()
  z4.get(
    '/usage',
    {
      schema: {
        querystring: z.object({ window: z.enum(['live', '24h', '7d', '30d', '90d']).default('24h') }),
        response: {
          200: z.object({ window: z.string(), totals: Totals, rows: z.array(Row), trend: z.array(Trend), users: z.array(UserRow), capabilityHealth: DashboardCapabilityHealthSchema }),
        },
      },
    },
    async (req) => {
      const settings = await getEffectiveSettings()
      const [usage, capabilityHealth] = await Promise.all([
        aggregateUsage({ window: req.query.window }),
        getDashboardCapabilityHealth(settings, req.identity!.userId),
      ])
      return { ...usage, capabilityHealth }
    },
  )
}
