/**
 * /dashboard/workers — the managed scheduled-worker control plane (Phase 5).
 *
 * Mirrors /dashboard/services: the READS are registered OUTSIDE the requireAdmin scope
 * (any authenticated user may view the Workers monitor — see dashboard/index.ts); the
 * MUTATIONS keep their own per-route requireSuperuser (they change what runs on the
 * server, like start/stop of a container).
 *
 *   • GET  /dashboard/workers                  — list managed jobs (schedule + status +
 *     next-run) + worker liveness. ANY authenticated user.
 *   • GET  /dashboard/workers/:name/logs       — last-run summary + error. ANY authenticated user.
 *   • POST /dashboard/workers/:name/:action    — pause | resume | run-now. requireSuperuser.
 *   • PUT  /dashboard/workers/:name            — edit schedule {cron?, enabled?}. requireSuperuser.
 *
 * The durable schedule lives in the ScheduledJob control table; the BullMQ
 * scheduler is reconciled to it here (and on worker boot). Reads degrade gracefully
 * if Redis is down (rows still render; next-run/liveness blank).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { requireSuperuser } from '../../authz/guards.ts'
import {
  listScheduledJobs,
  jobLog,
  pauseJob,
  resumeJob,
  runJobNow,
  editJob,
  JobNotFoundError,
  InvalidCronError,
} from '../../services/scheduled.ts'

const WorkerRow = z.object({
  name: z.string(),
  description: z.string(),
  cron: z.string(),
  enabled: z.boolean(),
  status: z.string(),
  lastRunAt: z.string().nullable(),
  lastFinishAt: z.string().nullable(),
  lastDurationMs: z.number().nullable(),
  lastError: z.string().nullable(),
  logTail: z.string().nullable(),
  errorCount: z.number(),
  nextRunAt: z.string().nullable(),
})
const Liveness = z.object({ alive: z.boolean(), lastBeatAgoMs: z.number().nullable() })
const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })

export async function dashboardWorkerRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── GET /dashboard/workers ──────────────────────────────────────────────────────
  z4.get(
    '/workers',
    { schema: { response: { 200: z.object({ workers: z.array(WorkerRow), liveness: Liveness }) } } },
    async () => listScheduledJobs(),
  )

  // ── GET /dashboard/workers/:name/logs ───────────────────────────────────────────
  z4.get(
    '/workers/:name/logs',
    {
      schema: {
        params: z.object({ name: z.string().min(1) }),
        response: {
          200: z.object({
            name: z.string(),
            status: z.string(),
            logTail: z.string().nullable(),
            lastError: z.string().nullable(),
            lastRunAt: z.string().nullable(),
            lastFinishAt: z.string().nullable(),
          }),
          404: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      try {
        return reply.code(200).send(await jobLog(req.params.name))
      } catch (err) {
        if (err instanceof JobNotFoundError) {
          return reply.code(404).send({ error: err.code, message: err.message })
        }
        throw err
      }
    },
  )

  // ── POST /dashboard/workers/:name/:action — superuser-only ──────────────────────
  z4.post(
    '/workers/:name/:action',
    {
      preHandler: [requireSuperuser],
      schema: {
        params: z.object({
          name: z.string().min(1),
          action: z.enum(['pause', 'resume', 'run-now']),
        }),
        response: { 200: z.object({ ok: z.boolean() }), 400: ErrorBody, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const { name, action } = req.params
      try {
        if (action === 'pause') await pauseJob(name)
        else if (action === 'resume') await resumeJob(name)
        else await runJobNow(name)
        return reply.code(200).send({ ok: true })
      } catch (err) {
        if (err instanceof InvalidCronError) return reply.code(400).send({ error: err.code, message: err.message })
        if (err instanceof JobNotFoundError) return reply.code(404).send({ error: err.code, message: err.message })
        throw err
      }
    },
  )

  // ── PUT /dashboard/workers/:name — edit schedule, superuser-only ────────────────
  z4.put(
    '/workers/:name',
    {
      preHandler: [requireSuperuser],
      schema: {
        params: z.object({ name: z.string().min(1) }),
        body: z.object({ cron: z.string().min(1).optional(), enabled: z.boolean().optional() }),
        response: { 200: z.object({ ok: z.boolean() }), 400: ErrorBody, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      try {
        await editJob(req.params.name, req.body)
        return reply.code(200).send({ ok: true })
      } catch (err) {
        if (err instanceof InvalidCronError) return reply.code(400).send({ error: err.code, message: err.message })
        if (err instanceof JobNotFoundError) return reply.code(404).send({ error: err.code, message: err.message })
        throw err
      }
    },
  )
}
