import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma } from '@pm/db'
import type { EmbeddingMode, EmbeddingTopology } from '@pm/shared'
import { requireSuperuser } from '../../authz/guards.ts'
import { ForbiddenError } from '../../authz/errors.ts'
import { config } from '../../config.ts'
import { ConflictError } from './shared.ts'
import { getEffectiveSettings } from '../../services/settings.ts'
import { wireModeToDb } from '../../services/embedding-topology.ts'
import {
  connectorEmailMatchesLocalProfile,
  decideSharedConnectionCompatibility,
  normalizeRemoteTopology,
  type CompatibilityDecision,
} from '../../services/shared-connection.ts'

const SINGLETON_ID = 'singleton'

const RemoteConfig = z.object({
  embeddingTopology: z.enum(['server-managed-embeddings', 'client-managed-embeddings']).optional(),
  embeddingMode: z.enum(['server', 'client-bridge']).optional(),
  activeModel: z.string(),
  activeDim: z.number().int().positive(),
  activeVectorName: z.string().optional(),
  deploymentMode: z.enum(['server', 'local']).optional(),
  dashboardLoginMode: z.enum(['password', 'sso']).optional(),
})

const RemoteIdentity = z.object({
  userId: z.string(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable().optional(),
  userDisplayName: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
  adminLevel: z.enum(['none', 'admin', 'superuser']),
  isTeamMember: z.boolean().optional(),
  isTeamAdmin: z.boolean().optional(),
  isGlobalSuperuser: z.boolean().optional(),
  deploymentMode: z.enum(['server', 'local']).optional(),
})

const CompatibilityOut = z.object({
  ok: z.boolean(),
  requiresLocalEmbedding: z.boolean(),
  reason: z.string().optional(),
})

const ConnectionOut = z.object({
  configured: z.boolean(),
  apiUrl: z.string().nullable(),
  tokenConfigured: z.boolean(),
  token: z.string().optional(),
  connectedAt: z.date().nullable(),
  checkedAt: z.date().nullable(),
  remoteConfig: RemoteConfig.nullable(),
  remoteIdentity: RemoteIdentity.nullable(),
  compatibility: CompatibilityOut.nullable(),
})

type RemoteConfigShape = z.infer<typeof RemoteConfig>
type RemoteIdentityShape = z.infer<typeof RemoteIdentity>

function assertLocalConnectionSurface(): void {
  if (config.DEPLOYMENT_MODE !== 'local') {
    throw new ForbiddenError('local_only', 'Shared Memories connections are managed from the local personal dashboard.')
  }
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '')
}

async function localProfileEmail(userId: string): Promise<string | null> {
  const user = await ownerPrisma.appUser.findUnique({
    where: { id: userId },
    select: { email: true },
  })
  return user?.email ?? null
}

async function assertConnectorEmailMatchesLocalProfile(
  localUserId: string,
  remoteEmail: string | null | undefined,
): Promise<void> {
  const localEmail = await localProfileEmail(localUserId)
  if (connectorEmailMatchesLocalProfile(localEmail, remoteEmail)) return
  throw new ConflictError(
    'shared_connection_email_mismatch',
    `Connector token email (${remoteEmail || 'not provided'}) does not match this local dashboard profile email (${localEmail || 'not set'}). ` +
      'Update your local profile email or mint a connector token for the same email.',
  )
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

async function testRemoteConnection(apiUrl: string, token: string): Promise<{
  config: RemoteConfigShape
  whoami: RemoteIdentityShape
  compatibility: CompatibilityDecision
}> {
  const base = normalizeApiUrl(apiUrl)
  const config = RemoteConfig.parse(await fetchJson(`${base}/config`))
  const whoami = RemoteIdentity.parse(await fetchJson(`${base}/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  const local = await getEffectiveSettings()
  const topology = normalizeRemoteTopology({
    embeddingTopology: config.embeddingTopology as EmbeddingTopology | undefined,
    embeddingMode: config.embeddingMode as EmbeddingMode | undefined,
  })
  const compatibility = decideSharedConnectionCompatibility({
    local: { model: local.activeEmbedModel, dim: local.activeEmbedDim },
    remote: { topology, model: config.activeModel, dim: config.activeDim },
  })
  return {
    config: { ...config, embeddingTopology: topology },
    whoami,
    compatibility,
  }
}

function maskConnection(
  row: unknown,
  includeToken: boolean,
  local: { model: string; dim: number },
): z.infer<typeof ConnectionOut> {
  const r = (row ?? {}) as {
    sharedMemoryApiUrl?: string | null
    sharedMemoryToken?: string | null
    sharedMemoryConnectedAt?: Date | null
    sharedMemoryCheckedAt?: Date | null
    sharedMemoryRemoteConfig?: unknown
    sharedMemoryRemoteIdentity?: unknown
  }
  const remoteConfig = r.sharedMemoryRemoteConfig
    ? RemoteConfig.parse(r.sharedMemoryRemoteConfig)
    : null
  const remoteIdentity = r.sharedMemoryRemoteIdentity
    ? RemoteIdentity.parse(r.sharedMemoryRemoteIdentity)
    : null
  const compatibility = remoteConfig
    ? decideSharedConnectionCompatibility({
        local,
        remote: {
          topology: normalizeRemoteTopology({
            embeddingTopology: remoteConfig.embeddingTopology as EmbeddingTopology | undefined,
            embeddingMode: remoteConfig.embeddingMode as EmbeddingMode | undefined,
          }),
          model: remoteConfig.activeModel,
          dim: remoteConfig.activeDim,
        },
      })
    : null
  return {
    configured: Boolean(r.sharedMemoryApiUrl && r.sharedMemoryToken),
    apiUrl: r.sharedMemoryApiUrl ?? null,
    tokenConfigured: Boolean(r.sharedMemoryToken),
    ...(includeToken && r.sharedMemoryToken ? { token: r.sharedMemoryToken } : {}),
    connectedAt: r.sharedMemoryConnectedAt ?? null,
    checkedAt: r.sharedMemoryCheckedAt ?? null,
    remoteConfig,
    remoteIdentity,
    compatibility,
  }
}

export async function dashboardSharedConnectionRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/shared-connection',
    {
      schema: {
        querystring: z.object({ includeToken: z.coerce.boolean().optional() }).optional(),
        response: { 200: ConnectionOut },
      },
    },
    async (req) => {
      assertLocalConnectionSurface()
      const includeToken = req.query?.includeToken === true
      const row = await ownerPrisma.systemSettings.findUnique({ where: { id: SINGLETON_ID } })
      const eff = await getEffectiveSettings()
      return maskConnection(row, includeToken, {
        model: eff.activeEmbedModel,
        dim: eff.activeEmbedDim,
      })
    },
  )

  z4.post(
    '/shared-connection/test',
    {
      schema: {
        body: z.object({
          apiUrl: z.string().url(),
          token: z.string().min(3),
        }).strict(),
        response: {
          200: z.object({
            config: RemoteConfig,
            whoami: RemoteIdentity,
            compatibility: CompatibilityOut,
          }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req) => {
      assertLocalConnectionSurface()
      const tested = await testRemoteConnection(req.body.apiUrl, req.body.token)
      await assertConnectorEmailMatchesLocalProfile(req.identity!.userId, tested.whoami.userEmail)
      return tested
    },
  )

  z4.put(
    '/shared-connection',
    {
      preHandler: [requireSuperuser],
      schema: {
        body: z.object({
          apiUrl: z.string().url(),
          token: z.string().min(3),
        }).strict(),
        response: {
          200: ConnectionOut,
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req) => {
      assertLocalConnectionSurface()
      const tested = await testRemoteConnection(req.body.apiUrl, req.body.token)
      await assertConnectorEmailMatchesLocalProfile(req.identity!.userId, tested.whoami.userEmail)
      if (!tested.compatibility.ok) {
        throw new ConflictError('embedding_topology_mismatch', tested.compatibility.reason ?? 'Shared connection is not compatible with this local stack.')
      }
      const eff = await getEffectiveSettings()
      const now = new Date()
      await ownerPrisma.systemSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {
          sharedMemoryApiUrl: normalizeApiUrl(req.body.apiUrl),
          sharedMemoryToken: req.body.token.trim(),
          sharedMemoryConnectedAt: now,
          sharedMemoryCheckedAt: now,
          sharedMemoryRemoteConfig: tested.config,
          sharedMemoryRemoteIdentity: tested.whoami,
          updatedById: req.identity!.userId,
        } as never,
        create: {
          id: SINGLETON_ID,
          embeddingMode: wireModeToDb(eff.embeddingMode),
          activeEmbedModel: eff.activeEmbedModel,
          activeEmbedDim: eff.activeEmbedDim,
          sharedMemoryApiUrl: normalizeApiUrl(req.body.apiUrl),
          sharedMemoryToken: req.body.token.trim(),
          sharedMemoryConnectedAt: now,
          sharedMemoryCheckedAt: now,
          sharedMemoryRemoteConfig: tested.config,
          sharedMemoryRemoteIdentity: tested.whoami,
          updatedById: req.identity!.userId,
        } as never,
      })
      const row = await ownerPrisma.systemSettings.findUnique({ where: { id: SINGLETON_ID } })
      return maskConnection(row, false, {
        model: eff.activeEmbedModel,
        dim: eff.activeEmbedDim,
      })
    },
  )

  z4.delete(
    '/shared-connection',
    {
      preHandler: [requireSuperuser],
      schema: { response: { 200: ConnectionOut } },
    },
    async (req) => {
      assertLocalConnectionSurface()
      const eff = await getEffectiveSettings()
      await ownerPrisma.systemSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {
          sharedMemoryApiUrl: null,
          sharedMemoryToken: null,
          sharedMemoryConnectedAt: null,
          sharedMemoryCheckedAt: null,
          sharedMemoryRemoteConfig: null,
          sharedMemoryRemoteIdentity: null,
          updatedById: req.identity!.userId,
        } as never,
        create: {
          id: SINGLETON_ID,
          embeddingMode: wireModeToDb(eff.embeddingMode),
          activeEmbedModel: eff.activeEmbedModel,
          activeEmbedDim: eff.activeEmbedDim,
          updatedById: req.identity!.userId,
        } as never,
      })
      const row = await ownerPrisma.systemSettings.findUnique({ where: { id: SINGLETON_ID } })
      return maskConnection(row, false, {
        model: eff.activeEmbedModel,
        dim: eff.activeEmbedDim,
      })
    },
  )
}
