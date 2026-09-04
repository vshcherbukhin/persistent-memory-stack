/**
 * POST /internal/usage — internal usage ingest (graphiti-service reports its LLM
 * token usage here). NOT under the secured/dashboard scopes (graphiti has no user
 * token); gated instead by a shared secret USAGE_INGEST_TOKEN (constant-time,
 * fail-closed when empty — mirrors the docker-control gate). Records via the
 * fire-and-forget recorder and returns 202.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../../config.ts'
import { ownerPrisma, recordUsageFireAndForget } from '@pm/db'

/** Constant-time `Authorization: Bearer <token>` check. Empty token ⇒ false (fail-closed). Pure. */
export function bearerOk(header: string | undefined, token: string): boolean {
  if (!token) return false
  const expected = Buffer.from(`Bearer ${token}`)
  const got = Buffer.from(header ?? '')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export async function internalUsageRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()
  z4.post(
    '/internal/usage',
    {
      schema: {
        body: z.object({
          service: z.string().min(1),
          model: z.string().min(1),
          tokens_in: z.number().int().min(0),
          tokens_out: z.number().int().min(0),
          graph: z.object({
            operation_id: z.string().min(1), subject_kind: z.enum(['memory', 'document']), subject_id: z.string().uuid(),
            team_id: z.string().uuid(), project: z.string().min(1), graph_group_id: z.string().min(1), stage: z.string().min(1), duration_ms: z.number().int().nonnegative(), success: z.boolean(),
          }).optional(),
        }),
        response: { 202: z.object({ ok: z.boolean() }), 401: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      if (!bearerOk(req.headers.authorization, config.USAGE_INGEST_TOKEN)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
      recordUsageFireAndForget({
        service: req.body.service, model: req.body.model,
        tokensIn: req.body.tokens_in, tokensOut: req.body.tokens_out,
      })
      if (req.body.graph) {
        void ownerPrisma.graphUsageEvent.create({ data: {
          operationId: req.body.graph.operation_id, subjectKind: req.body.graph.subject_kind, subjectId: req.body.graph.subject_id,
          teamId: req.body.graph.team_id, project: req.body.graph.project, graphGroupId: req.body.graph.graph_group_id,
          stage: req.body.graph.stage, model: req.body.model, tokensIn: BigInt(req.body.tokens_in), tokensOut: BigInt(req.body.tokens_out),
          durationMs: req.body.graph.duration_ms, success: req.body.graph.success,
        } }).catch((err) => app.log.warn({ err }, 'graph usage event was not recorded'))
      }
      return reply.code(202).send({ ok: true })
    },
  )
}
