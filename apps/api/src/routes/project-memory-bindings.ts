/**
 * Personal-stack project-to-surface bindings.
 *
 * This is deliberately a data-plane endpoint: the authenticated user owns the
 * decision, and the Personal stack persists it so a later MCP session cannot
 * silently switch a named project between Personal and Shared memory.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { getCtx, runInTenant, type Tx } from '@pm/db'
import { requireTeamMember } from '../authz/guards.ts'
import { forbidden } from '../authz/errors.ts'
import { config } from '../config.ts'

const Surface = z.enum(['personal', 'shared'])
const Project = z.string().min(1).max(200)

function assertPersonalBindingStore(): void {
  const surface = config.MEMORY_SURFACE ?? (config.DEPLOYMENT_MODE === 'local' ? 'personal' : 'shared')
  if (surface !== 'personal') {
    throw forbidden(
      'personal_binding_store_required',
      'Project memory-surface bindings are stored only by the Personal Memories stack.',
    )
  }
}

export async function projectMemoryBindingRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/project-memory-bindings/:project',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: z.object({ project: Project }),
        response: {
          200: z.object({ project: z.string(), surface: Surface.nullable() }),
          403: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      assertPersonalBindingStore()
      const identity = getCtx()
      const binding = await runInTenant((tx: Tx) => tx.projectMemoryBinding.findUnique({
        where: { userId_project: { userId: identity.userId, project: req.params.project } },
        select: { surface: true },
      }))
      return reply.send({ project: req.params.project, surface: binding?.surface ?? null })
    },
  )

  z4.post(
    '/project-memory-bindings',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: z.object({ project: Project, surface: Surface }).strict(),
        response: {
          200: z.object({ project: z.string(), surface: Surface }),
          403: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      assertPersonalBindingStore()
      const identity = getCtx()
      const { project, surface } = req.body
      if (project === 'general' && surface !== 'personal') {
        return reply.code(409).send({
          error: 'general_personal_only',
          message: 'Regular chat project "general" always uses Personal Memories.',
        })
      }
      const existing = await runInTenant((tx: Tx) => tx.projectMemoryBinding.findUnique({
        where: { userId_project: { userId: identity.userId, project } },
        select: { surface: true },
      }))
      if (existing && existing.surface !== surface) {
        return reply.code(409).send({
          error: 'project_surface_immutable',
          message: 'This project is already bound to a memory surface. Create a new project binding instead of silently splitting its history.',
        })
      }
      await runInTenant((tx: Tx) => tx.projectMemoryBinding.upsert({
        where: { userId_project: { userId: identity.userId, project } },
        create: { teamId: identity.teamId!, userId: identity.userId, project, surface },
        update: {},
      }))
      return reply.send({ project, surface })
    },
  )
}
