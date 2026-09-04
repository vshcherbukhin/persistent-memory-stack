/**
 * /dashboard/overview — compact control-plane + operations summary for the root
 * dashboard. Admin+ only (registered inside the requireAdmin scope).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { MODEL_REGISTRY } from '@pm/shared'
import { ownerPrisma, runInTenant, type Tx } from '@pm/db'
import { DockerUnavailableError, listServices, ollamaInfo } from '../../services/docker.ts'
import { isServiceFailed, isServiceUp, summarizeServiceRows } from '../../services/overview.ts'
import { listScheduledJobs } from '../../services/scheduled.ts'
import { aggregateUsage } from '../../services/usage.ts'
import { getEffectiveSettings } from '../../services/settings.ts'
import { listMcpClients, pruneIdleMcpClients } from '../../services/mcp-sessions.ts'
import { getDashboardCapabilityHealth } from '../../services/dashboard-capability-health.ts'
import { DashboardCapabilityHealthSchema } from './capability-health.ts'

const Counts = z.object({
  teams: z.number(),
  users: z.number(),
  superusers: z.number(),
  admins: z.number(),
  memories: z.number(),
})
const ServiceSummary = z.object({
  total: z.number(),
  active: z.number(),
  stopped: z.number(),
  failed: z.number(),
  healthy: z.number(),
  unhealthy: z.number(),
  starting: z.number(),
  unavailable: z.boolean(),
})
const McpSessionSummary = z.object({
  active: z.number(),
  stream: z.number(),
  legacy: z.number(),
  serviceStatus: z.enum(['running', 'stopped', 'error', 'unknown']),
})
const WorkerSummary = z.object({
  total: z.number(),
  enabled: z.number(),
  running: z.number(),
  failed: z.number(),
  alive: z.boolean(),
  lastBeatAgoMs: z.number().nullable(),
})
const UsageSummary = z.object({
  window: z.literal('24h'),
  tokens: z.number(),
  requests: z.number(),
  cost: z.number(),
})
const SettingsSummary = z.object({
  embeddingMode: z.string(),
  activeEmbedModel: z.string(),
  activeEmbedDim: z.number(),
  activeVectorName: z.string(),
  persisted: z.boolean(),
  factExtractionModel: z.string(),
  factExtractionProvider: z.string(),
})

function mcpServiceStatus(rows: Awaited<ReturnType<typeof listServices>>): z.infer<typeof McpSessionSummary>['serviceStatus'] {
  const mcp = rows.find((row) => row.service === 'mcp' && row.mcpSession !== true)
  if (!mcp) return 'unknown'
  if (isServiceFailed(mcp)) return 'error'
  if (isServiceUp(mcp)) return 'running'
  return 'stopped'
}

export async function serviceOverview(ollamaTarget: Parameters<typeof ollamaInfo>[0]): Promise<{
  services: z.infer<typeof ServiceSummary>
  mcpStatus: z.infer<typeof McpSessionSummary>['serviceStatus']
}> {
  try {
    const [containers, ollama] = await Promise.all([
      listServices({ includeCredentials: false }),
      ollamaInfo(ollamaTarget),
    ])
    return {
      services: summarizeServiceRows([...containers, ollama]),
      mcpStatus: mcpServiceStatus(containers),
    }
  } catch (err) {
    if (err instanceof DockerUnavailableError) {
      return {
        services: { total: 0, active: 0, stopped: 0, failed: 0, healthy: 0, unhealthy: 0, starting: 0, unavailable: true },
        mcpStatus: 'unknown',
      }
    }
    throw err
  }
}

export async function dashboardOverviewRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/overview',
    {
      schema: {
        response: {
          200: z.object({
            counts: Counts,
            services: ServiceSummary,
            mcpSessions: McpSessionSummary,
            workers: WorkerSummary,
            usage: UsageSummary,
            settings: SettingsSummary,
            capabilityHealth: DashboardCapabilityHealthSchema,
          }),
        },
      },
    },
    async (req) => {
      const identity = req.identity!
      const now = new Date()
      const settingsPromise = getEffectiveSettings()
      const serviceSummaryPromise = settingsPromise.then((settings) =>
        serviceOverview({
          model: settings.activeEmbedModel,
          provider: MODEL_REGISTRY[settings.activeEmbedModel]?.provider,
        }),
      )
      const capabilityHealthPromise = settingsPromise.then((settings) =>
        getDashboardCapabilityHealth(settings, identity.userId),
      )
      const [teams, users, superusers, admins, memories, serviceSummary, workersView, usage, settings, capabilityHealth] =
        await Promise.all([
          ownerPrisma.team.count(),
          ownerPrisma.appUser.count(),
          ownerPrisma.appUser.count({ where: { adminLevel: 'superuser' } }),
          ownerPrisma.appUser.count({ where: { adminLevel: 'admin' } }),
          runInTenant(
            (tx: Tx) => tx.memory.count(),
            { globalAdmin: identity.isGlobalSuperuser, readOnly: true, readAllMemory: true },
          ),
          serviceSummaryPromise,
          listScheduledJobs(),
          aggregateUsage({ window: '24h', now }),
          settingsPromise,
          capabilityHealthPromise,
        ])
      pruneIdleMcpClients(settings.mcpSessionIdleTimeoutSeconds, now)
      const mcpClients = listMcpClients(settings.mcpSessionIdleTimeoutSeconds)

      return {
        counts: { teams, users, superusers, admins, memories },
        services: serviceSummary.services,
        mcpSessions: {
          active: mcpClients.length,
          stream: mcpClients.filter((client) => client.connectionType === 'stream').length,
          legacy: mcpClients.filter((client) => client.connectionType === 'stdio').length,
          serviceStatus: serviceSummary.mcpStatus,
        },
        workers: {
          total: workersView.workers.length,
          enabled: workersView.workers.filter((w) => w.enabled).length,
          running: workersView.workers.filter((w) => w.status === 'running').length,
          failed: workersView.workers.filter((w) => w.status === 'failed' || w.errorCount > 0).length,
          alive: workersView.liveness.alive,
          lastBeatAgoMs: workersView.liveness.lastBeatAgoMs,
        },
        usage: {
          window: '24h' as const,
          tokens: usage.totals.tokens,
          requests: usage.totals.requests,
          cost: usage.totals.cost,
        },
        settings: {
          embeddingMode: settings.embeddingMode,
          activeEmbedModel: settings.activeEmbedModel,
          activeEmbedDim: settings.activeEmbedDim,
          activeVectorName: settings.activeVectorName,
          persisted: settings.persisted,
          factExtractionModel: settings.factExtraction.model,
          factExtractionProvider: settings.factExtraction.provider,
        },
        capabilityHealth,
      }
    },
  )
}
