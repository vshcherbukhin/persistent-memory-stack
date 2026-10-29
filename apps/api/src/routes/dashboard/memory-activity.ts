import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { memoryActivity } from '../../services/memory-activity.ts'

const Activity = z.object({ active: z.number().int().nonnegative(), state: z.enum(['idle', 'active', 'success', 'error', 'starting']), lastCompletedAt: z.string().nullable() })

export async function dashboardMemoryActivityRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get('/memory-activity', {
    schema: { response: { 200: z.object({ read: Activity, write: Activity, update: Activity }) } },
  }, async req => memoryActivity.snapshot(req.identity!))
}
