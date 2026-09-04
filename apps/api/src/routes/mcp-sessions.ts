import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { closeMcpClient, heartbeatMcpClient, upsertMcpClient } from '../services/mcp-sessions.ts'

const RegisterBody = z.object({
  id: z.string().min(1),
  clientName: z.string().min(1),
  connectionType: z.enum(['stream', 'stdio']),
  pid: z.number().int().positive().optional(),
  terminateSupported: z.boolean().optional(),
  lastActivityAt: z.string().datetime().optional(),
})

const IdParams = z.object({ id: z.string().min(1) })
const HeartbeatBody = z.object({ lastActivityAt: z.string().datetime().optional() }).strict().optional()

export async function mcpSessionRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.post(
    '/mcp-sessions',
    {
      schema: {
        body: RegisterBody,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      upsertMcpClient(req.body)
      return reply.code(200).send({ ok: true })
    },
  )

  z4.post(
    '/mcp-sessions/:id/heartbeat',
    {
      schema: {
        params: IdParams,
        body: HeartbeatBody,
        response: { 200: z.object({ terminate: z.boolean(), registered: z.boolean() }) },
      },
    },
    async (req, reply) => reply.code(200).send(heartbeatMcpClient(req.params.id, req.body ?? {})),
  )

  z4.delete(
    '/mcp-sessions/:id',
    {
      schema: {
        params: IdParams,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      closeMcpClient(req.params.id)
      return reply.code(200).send({ ok: true })
    },
  )
}
