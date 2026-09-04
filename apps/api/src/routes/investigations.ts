/**
 * persistent-memory-api — investigation endpoints (Phase 7). Map to the P8 MCP
 * tools create_investigation / get_investigation / link_investigation.
 *
 *   • POST /investigations          — requireWrite; teamId server-stamped.
 *   • GET  /investigations/:id       — requireRead; findUnique include links;
 *                                      RLS fail-closed → 404.
 *   • POST /investigations/:id/links — requireWrite; in ONE runInTenant verify
 *     the investigation is readable (404 else), verify the link TARGET is
 *     readable by targetType (404 target_not_found else), create the link
 *     stamped with own teamId. Prisma P2002 (idempotent re-link) → 200 with the
 *     existing link.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { runInTenant, Prisma, type Tx } from '@pm/db'
import { requireTeamMember } from '../authz/guards.ts'

const LinkSchema = z.object({
  id: z.string(),
  investigationId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
})

const InvestigationSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  project: z.string(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
})

/** Link target types we know how to existence-check under RLS. */
const TARGET_TYPES = ['memory', 'document', 'source', 'chunk', 'claim', 'entity'] as const
type TargetType = (typeof TARGET_TYPES)[number]

/** Existence-check a link target under the current tenant (RLS-scoped). */
async function targetReadable(tx: Tx, targetType: TargetType, targetId: string): Promise<boolean> {
  const where = { where: { id: targetId }, select: { id: true } }
  switch (targetType) {
    case 'memory':
      return (await tx.memory.findUnique(where)) !== null
    case 'document':
      return (await tx.document.findUnique(where)) !== null
    case 'source':
      return (await tx.source.findUnique(where)) !== null
    case 'chunk':
      return (await tx.chunk.findUnique(where)) !== null
    case 'claim':
      return (await tx.claim.findUnique(where)) !== null
    case 'entity':
      return (await tx.entity.findUnique(where)) !== null
    default:
      return false
  }
}

export async function investigationRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── POST /investigations — create_investigation ────────────────────────────
  const CreateBody = z
    .object({
      title: z.string().min(1),
      description: z.string().optional(),
      project: z.string().min(1).default('general'),
      status: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .strict()

  z4.post(
    '/investigations',
    {
      preHandler: [requireTeamMember],
      schema: { body: CreateBody, response: { 201: InvestigationSchema } },
    },
    async (req, reply) => {
      const id = req.identity!
      const body = req.body
      type Row = {
        id: string
        title: string
        description: string | null
        status: string
        project: string
        sessionId: string | null
        createdAt: Date
      }
      const inv = await runInTenant<Row>(
        (tx: Tx) =>
          tx.investigation.create({
            data: {
              teamId: id.teamId!, // ← SERVER-STAMPED; RLS WITH CHECK backstops
              project: body.project,
              title: body.title,
              description: body.description ?? null,
              ...(body.status ? { status: body.status } : {}),
              sessionId: body.sessionId ?? null,
            },
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              project: true,
              sessionId: true,
              createdAt: true,
            },
          }) as PromiseLike<Row>,
      )
      return reply.code(201).send({ ...inv, createdAt: inv.createdAt.toISOString() })
    },
  )

  // ── GET /investigations/:id — get_investigation (RLS → 404; include links) ──
  z4.get(
    '/investigations/:id',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: InvestigationSchema.extend({ links: z.array(LinkSchema) }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      type LinkRow = {
        id: string
        investigationId: string
        targetType: string
        targetId: string
        note: string | null
        createdAt: Date
      }
      type Row = {
        id: string
        title: string
        description: string | null
        status: string
        project: string
        sessionId: string | null
        createdAt: Date
        links: LinkRow[]
      }
      const inv = await runInTenant<Row | null>(
        (tx: Tx) =>
          tx.investigation.findUnique({
            where: { id: req.params.id },
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              project: true,
              sessionId: true,
              createdAt: true,
              links: {
                select: {
                  id: true,
                  investigationId: true,
                  targetType: true,
                  targetId: true,
                  note: true,
                  createdAt: true,
                },
              },
            },
          }) as PromiseLike<Row | null>,
      )
      if (!inv) return reply.code(404).send({ error: 'not_found' })
      return reply.code(200).send({
        id: inv.id,
        title: inv.title,
        description: inv.description,
        status: inv.status,
        project: inv.project,
        sessionId: inv.sessionId,
        createdAt: inv.createdAt.toISOString(),
        links: inv.links.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
      })
    },
  )

  // ── POST /investigations/:id/links — link_investigation ─────────────────────
  const LinkBody = z
    .object({
      targetType: z.enum(TARGET_TYPES),
      targetId: z.string().uuid(),
      note: z.string().optional(),
    })
    .strict()

  z4.post(
    '/investigations/:id/links',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: LinkBody,
        response: {
          200: LinkSchema, // idempotent re-link returns the existing link
          201: LinkSchema,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const body = req.body
      const investigationId = req.params.id

      type LinkRow = {
        id: string
        investigationId: string
        targetType: string
        targetId: string
        note: string | null
        createdAt: Date
      }

      // ONE tx: verify investigation readable → verify target readable → create.
      const result = await runInTenant<
        { kind: 'created' | 'exists'; link: LinkRow } | { kind: 'inv_not_found' } | { kind: 'target_not_found' }
      >(async (tx: Tx) => {
        const inv = await tx.investigation.findUnique({
          where: { id: investigationId },
          select: { id: true },
        })
        if (!inv) return { kind: 'inv_not_found' as const }

        const ok = await targetReadable(tx, body.targetType, body.targetId)
        if (!ok) return { kind: 'target_not_found' as const }

        try {
          const link = (await tx.investigationLink.create({
            data: {
              teamId: id.teamId!, // ← SERVER-STAMPED
              project: 'general', // links inherit the tenant; project tag default
              investigationId,
              targetType: body.targetType,
              targetId: body.targetId,
              note: body.note ?? null,
            },
            select: {
              id: true,
              investigationId: true,
              targetType: true,
              targetId: true,
              note: true,
              createdAt: true,
            },
          })) as LinkRow
          return { kind: 'created' as const, link }
        } catch (err) {
          // P2002 = unique(investigationId, targetType, targetId) → idempotent.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            const existing = (await tx.investigationLink.findFirst({
              where: {
                investigationId,
                targetType: body.targetType,
                targetId: body.targetId,
              },
              select: {
                id: true,
                investigationId: true,
                targetType: true,
                targetId: true,
                note: true,
                createdAt: true,
              },
            })) as LinkRow
            return { kind: 'exists' as const, link: existing }
          }
          throw err
        }
      })

      if (result.kind === 'inv_not_found') return reply.code(404).send({ error: 'not_found' })
      if (result.kind === 'target_not_found') {
        return reply.code(404).send({ error: 'target_not_found' })
      }
      const wire = { ...result.link, createdAt: result.link.createdAt.toISOString() }
      return reply.code(result.kind === 'created' ? 201 : 200).send(wire)
    },
  )
}
