/**
 * /dashboard/services — the local stack service monitor.
 *
 *   • GET  /dashboard/services            — list the stack's containers + state/health
 *     (+ service UI links, admin/superuser-only credentials, and a read-only
 *     host-Ollama reachability row). ANY authenticated user (this route is
 *     registered OUTSIDE the requireAdmin scope — see dashboard/index.ts).
 *   • GET  /dashboard/services/:service/logs?tail=N — tail a service's logs. ANY authenticated user.
 *   • POST /dashboard/services/:service/:action     — start | stop | restart | terminate. requireSuperuser
 *     (it controls host infrastructure). Restarting/stopping the `api` itself will
 *     briefly drop this dashboard's connection — the UI warns + reconnects.
 *     `terminate` is restricted to exact legacy MCP container cleanup.
 *
 * Works in server-managed embeddings and client-managed embeddings (the container set is identical). Backed by the
 * Docker socket (services/docker.ts); a missing socket → 503 docker_unavailable.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { MODEL_REGISTRY } from '@pm/shared'
import { requireSuperuser } from '../../authz/guards.ts'
import {
  listServices,
  ollamaInfo,
  serviceLogs,
  actOnService,
  terminateMcpService,
  DockerUnavailableError,
} from '../../services/docker.ts'
import { listMcpClients, pruneIdleMcpClients, terminateMcpClient } from '../../services/mcp-sessions.ts'
import { getEffectiveSettings } from '../../services/settings.ts'
import { getDashboardCapabilityHealth, type DashboardCapabilityHealth } from '../../services/dashboard-capability-health.ts'
import { DashboardCapabilityHealthSchema } from './capability-health.ts'

const ServiceUi = z.object({
  label: z.string(),
  url: z.string().url(),
})
const ServiceCredential = z.object({
  label: z.string(),
  value: z.string(),
})
const ServiceRow = z.object({
  service: z.string(),
  name: z.string(),
  id: z.string(),
  state: z.string(),
  status: z.string(),
  health: z.enum(['healthy', 'unhealthy', 'starting']).nullable(),
  controllable: z.boolean(),
  logsAvailable: z.boolean().optional(),
  configuredModel: z.string().optional(),
  configuredModelState: z.enum(['present', 'missing', 'not_configured']).optional(),
  mcpSession: z.boolean().optional(),
  ui: ServiceUi.optional(),
  credentials: z.array(ServiceCredential).optional(),
})
type ServiceRowValue = z.infer<typeof ServiceRow>
const McpClientRow = z.object({
  id: z.string(),
  clientName: z.string(),
  connectionType: z.enum(['stream', 'stdio']),
  pid: z.number().int().nullable(),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  lastActivityAt: z.string(),
  terminatesAt: z.string().nullable(),
  terminateSupported: z.boolean(),
  terminateRequested: z.boolean(),
})
const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })

function capabilityStatusDetail(record: DashboardCapabilityHealth['factExtraction']): string {
  if (record.state === 'healthy') return 'Latest request or test succeeded.'
  if (record.state === 'unknown') return 'Not observed yet. Run a test to establish health.'
  return record.safeMessage ?? 'This capability needs attention.'
}

export function dependencyHealthToServiceRows(health: DashboardCapabilityHealth): ServiceRowValue[] {
  return [
    {
      service: 'fact-extraction',
      name: 'Fact extraction',
      id: '',
      state: health.factExtraction.state,
      status: capabilityStatusDetail(health.factExtraction),
      health: health.factExtraction.state === 'healthy' ? 'healthy' : health.factExtraction.state === 'unknown' ? null : 'unhealthy',
      controllable: false,
      logsAvailable: false,
      ...(health.factExtraction.model ? { configuredModel: health.factExtraction.model } : {}),
    },
    {
      service: 'embeddings',
      name: 'Embeddings',
      id: '',
      state: health.embeddings.state,
      status: capabilityStatusDetail(health.embeddings),
      health: health.embeddings.state === 'healthy' ? 'healthy' : health.embeddings.state === 'unknown' ? null : 'unhealthy',
      controllable: false,
      logsAvailable: false,
      ...(health.embeddings.model ? { configuredModel: health.embeddings.model } : {}),
    },
  ]
}

export async function dashboardServiceRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── GET /dashboard/services ─────────────────────────────────────────────────────
  z4.get(
    '/services',
    { schema: { response: { 200: z.object({ services: z.array(ServiceRow), mcpClients: z.array(McpClientRow), capabilityHealth: DashboardCapabilityHealthSchema }), 503: ErrorBody } } },
    async (req, reply) => {
      try {
        const includeCredentials = req.identity?.adminLevel === 'admin' || req.identity?.adminLevel === 'superuser'
        const [containers, settings] = await Promise.all([
          listServices({ includeCredentials }),
          getEffectiveSettings(),
        ])
        const provider = MODEL_REGISTRY[settings.activeEmbedModel]?.provider
        const [ollama, capabilityHealth] = await Promise.all([
          ollamaInfo({ model: settings.activeEmbedModel, provider }),
          getDashboardCapabilityHealth(settings, req.identity!.userId),
        ])
        pruneIdleMcpClients(settings.mcpSessionIdleTimeoutSeconds)
        return reply.code(200).send({
          services: [...containers, ...dependencyHealthToServiceRows(capabilityHealth), ollama],
          mcpClients: listMcpClients(settings.mcpSessionIdleTimeoutSeconds),
          capabilityHealth,
        })
      } catch (err) {
        if (err instanceof DockerUnavailableError) {
          return reply.code(503).send({ error: err.code, message: err.message })
        }
        throw err
      }
    },
  )

  // ── GET /dashboard/services/:service/logs ───────────────────────────────────────
  z4.get(
    '/services/:service/logs',
    {
      schema: {
        params: z.object({ service: z.string().min(1) }),
        querystring: z.object({ tail: z.coerce.number().int().min(1).max(2000).default(200) }),
        response: { 200: z.object({ service: z.string(), logs: z.string() }), 503: ErrorBody },
      },
    },
    async (req, reply) => {
      try {
        const logs = await serviceLogs(req.params.service, req.query.tail)
        return reply.code(200).send({ service: req.params.service, logs })
      } catch (err) {
        if (err instanceof DockerUnavailableError) {
          return reply.code(503).send({ error: err.code, message: err.message })
        }
        throw err
      }
    },
  )

  // ── POST /dashboard/services/:service/:action — superuser-only (host control) ────
  z4.post(
    '/services/:service/:action',
    {
      preHandler: [requireSuperuser],
      schema: {
        params: z.object({
          service: z.string().min(1),
          action: z.enum(['start', 'stop', 'restart', 'terminate']),
        }),
        response: { 200: z.object({ ok: z.boolean() }), 503: ErrorBody },
      },
    },
    async (req, reply) => {
      try {
        const r = req.params.action === 'terminate'
          ? await terminateMcpService(req.params.service)
          : await actOnService(req.params.service, req.params.action)
        return reply.code(200).send(r)
      } catch (err) {
        if (err instanceof DockerUnavailableError) {
          return reply.code(503).send({ error: err.code, message: err.message })
        }
        throw err
      }
    },
  )

  // ── POST /dashboard/mcp-clients/:id/terminate — cooperative stdio termination ───
  z4.post(
    '/mcp-clients/:id/terminate',
    {
      preHandler: [requireSuperuser],
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ ok: z.boolean(), reason: z.string().optional() }) },
      },
    },
    async (req, reply) => reply.code(200).send(terminateMcpClient(req.params.id)),
  )
}
