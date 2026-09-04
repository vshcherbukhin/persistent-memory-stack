/**
 * /dashboard/update — snapshot-safe update control plane.
 *
 * Status can include host paths, release diffs, and operational logs, so
 * the full surface is superuser-only. The API is only a proxy/RBAC choke-point;
 * the update-runner sidecar owns git/compose work.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { requireSuperuser } from '../../authz/guards.ts'
import {
  getUpdateSettings,
  getUpdateLogs,
  getUpdateStatus,
  saveUpdateSettings,
  startUpdate,
  testUpdateSettings,
  UpdateRunnerRequestError,
  UpdateRunnerUnavailableError,
} from '../../services/update-runner.ts'

const ServiceRelease = z.object({
  service: z.string(),
  version: z.string(),
  change: z.string(),
})
const ReleaseNotes = z.object({
  version: z.string(),
  date: z.string(),
  latest: z.boolean(),
  services: z.array(ServiceRelease),
  mcpRestartRequired: z.boolean(),
  body: z.string(),
})
const UpdateRunSummary = z.object({
  ok: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  backupPath: z.string().optional(),
  error: z.string().optional(),
})
const PostUpdateSignal = z.object({
  id: z.string(),
  source: z.enum(['update-script', 'update-runner']),
  version: z.string(),
  finishedAt: z.string(),
})
const UpdateStatus = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  autoUpdateReady: z.boolean().optional(),
  currentCommit: z.string().optional(),
  latestCommit: z.string().optional(),
  releaseNotes: ReleaseNotes.nullable().optional(),
  mcpRestartRequired: z.boolean().optional(),
  running: z.boolean(),
  lastRun: UpdateRunSummary.optional(),
  lastSuccessfulUpdate: PostUpdateSignal.optional(),
  logs: z.array(z.string()),
})
const UpdateLogs = z.object({
  running: z.boolean(),
  logs: z.array(z.string()),
  lastRun: UpdateRunSummary.optional(),
})
const UpdateBitbucketSettings = z.object({
  url: z.string(),
  tokenConfigured: z.boolean(),
  scope: z.enum(['project', 'user']),
  project: z.string(),
  user: z.string(),
  repo: z.string(),
  branch: z.string(),
})
const UpdateSettings = z.object({
  enabled: z.boolean(),
  provider: z.enum(['none', 'bitbucket', 'git']),
  bitbucket: UpdateBitbucketSettings,
})
const UpdateSettingsInput = z.object({
  enabled: z.boolean(),
  provider: z.enum(['none', 'bitbucket']).optional(),
  bitbucket: z.object({
    url: z.string().optional(),
    token: z.string().optional(),
    scope: z.enum(['project', 'user']).optional(),
    project: z.string().optional(),
    user: z.string().optional(),
    repo: z.string().optional(),
    branch: z.string().optional(),
  }).optional(),
})
const UpdateConnectionTest = z.object({
  ok: z.literal(true),
  provider: z.literal('bitbucket'),
  repository: z.string(),
  branch: z.string(),
  latestCommit: z.string(),
  latestVersion: z.string().nullable(),
})
const ErrorBody = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.string().optional(),
  requestId: z.string().optional(),
})
const UpdateRunnerErrors = { 422: ErrorBody, 500: ErrorBody, 503: ErrorBody }

export async function dashboardUpdateRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/update',
    { preHandler: [requireSuperuser], schema: { response: { 200: UpdateStatus, ...UpdateRunnerErrors } } },
    async (_req, reply) => {
      try {
        return reply.code(200).send(await getUpdateStatus())
      } catch (err) {
        if (err instanceof UpdateRunnerUnavailableError) return reply.code(503).send({ error: err.code, message: err.message })
        if (err instanceof UpdateRunnerRequestError && err.statusCode === 422) return reply.code(422).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        if (err instanceof UpdateRunnerRequestError) return reply.code(500).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        throw err
      }
    },
  )

  z4.get(
    '/update/logs',
    { preHandler: [requireSuperuser], schema: { response: { 200: UpdateLogs, ...UpdateRunnerErrors } } },
    async (_req, reply) => {
      try {
        return reply.code(200).send(await getUpdateLogs())
      } catch (err) {
        if (err instanceof UpdateRunnerUnavailableError) return reply.code(503).send({ error: err.code, message: err.message })
        if (err instanceof UpdateRunnerRequestError && err.statusCode === 422) return reply.code(422).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        if (err instanceof UpdateRunnerRequestError) return reply.code(500).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        throw err
      }
    },
  )

  z4.post(
    '/update/start',
    {
      preHandler: [requireSuperuser],
      schema: { response: { 202: z.object({ ok: z.boolean() }), ...UpdateRunnerErrors } },
    },
    async (_req, reply) => {
      try {
        return reply.code(202).send(await startUpdate())
      } catch (err) {
        if (err instanceof UpdateRunnerUnavailableError) return reply.code(503).send({ error: err.code, message: err.message })
        if (err instanceof UpdateRunnerRequestError && err.statusCode === 422) return reply.code(422).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        if (err instanceof UpdateRunnerRequestError) return reply.code(500).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        throw err
      }
    },
  )

  z4.get(
    '/update/settings',
    { preHandler: [requireSuperuser], schema: { response: { 200: UpdateSettings, ...UpdateRunnerErrors } } },
    async (_req, reply) => {
      try {
        return reply.code(200).send(await getUpdateSettings())
      } catch (err) {
        if (err instanceof UpdateRunnerUnavailableError) return reply.code(503).send({ error: err.code, message: err.message })
        if (err instanceof UpdateRunnerRequestError && err.statusCode === 422) return reply.code(422).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        if (err instanceof UpdateRunnerRequestError) return reply.code(500).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        throw err
      }
    },
  )

  z4.patch(
    '/update/settings',
    {
      preHandler: [requireSuperuser],
      schema: { body: UpdateSettingsInput, response: { 200: UpdateSettings, ...UpdateRunnerErrors } },
    },
    async (req, reply) => {
      try {
        return reply.code(200).send(await saveUpdateSettings(req.body))
      } catch (err) {
        if (err instanceof UpdateRunnerUnavailableError) return reply.code(503).send({ error: err.code, message: err.message })
        if (err instanceof UpdateRunnerRequestError && err.statusCode === 422) return reply.code(422).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        if (err instanceof UpdateRunnerRequestError) return reply.code(500).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        throw err
      }
    },
  )

  z4.post(
    '/update/test',
    {
      preHandler: [requireSuperuser],
      schema: { body: UpdateSettingsInput, response: { 200: UpdateConnectionTest, ...UpdateRunnerErrors } },
    },
    async (req, reply) => {
      try {
        return reply.code(200).send(await testUpdateSettings(req.body))
      } catch (err) {
        if (err instanceof UpdateRunnerUnavailableError) return reply.code(503).send({ error: err.code, message: err.message })
        if (err instanceof UpdateRunnerRequestError && err.statusCode === 422) return reply.code(422).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        if (err instanceof UpdateRunnerRequestError) return reply.code(500).send({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })
        throw err
      }
    },
  )
}
