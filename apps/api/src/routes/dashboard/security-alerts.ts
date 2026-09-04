/**
 * /dashboard/security-alerts — the dashboard Security plane (Phase 8, #10).
 *
 * SecurityAlert is a DATA table with NON-universal RLS (rls.sql §5b): read is
 * own-team OR global super-admin. So a team-admin sees only their team's findings; a
 * super-admin sees ALL via the global-admin RLS path. Reads/writes go through pm_app +
 * runInTenant (NOT ownerPrisma) so RLS stays the backstop. Findings are
 * REDACTION-SAFE — the API never stored the raw secret/PII value.
 *
 * Registered inside the requireAdmin control scope (admin+ baseline). Resolve is
 * scoped by RLS: a team-admin can only resolve their own team's alerts (an
 * other-team id matches 0 rows → 404).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { runInTenant, type Tx, type TenantCtx } from '@pm/db'

const AlertRow = z.object({
  id: z.string(),
  teamId: z.string(),
  project: z.string(),
  sourceKind: z.string(),
  rowId: z.string().nullable(),
  detector: z.string(),
  findingType: z.string(),
  severity: z.string(),
  redactedExcerpt: z.string().nullable(),
  count: z.number(),
  resolved: z.boolean(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
})

const ALERT_SELECT = {
  id: true, teamId: true, project: true, sourceKind: true, rowId: true,
  detector: true, findingType: true, severity: true, redactedExcerpt: true,
  count: true, resolved: true, resolvedAt: true, createdAt: true,
} as const

interface Row {
  id: string; teamId: string; project: string; sourceKind: string; rowId: string | null
  detector: string; findingType: string; severity: string; redactedExcerpt: string | null
  count: number; resolved: boolean; resolvedAt: Date | null; createdAt: Date
}

/** Read scope: super → all teams (globalAdmin); team-admin → own team (ambient ctx). */
function readOpts(id: TenantCtx): { globalAdmin: boolean; readOnly: boolean } {
  return { globalAdmin: id.isGlobalSuperuser, readOnly: true }
}
/** Write scope: super → globalAdmin; team-admin → ambient team ctx (RLS team_write). */
function writeOpts(id: TenantCtx): { globalAdmin: boolean } | undefined {
  return id.isGlobalSuperuser ? { globalAdmin: true } : undefined
}

const toRow = (r: Row): z.infer<typeof AlertRow> => ({
  ...r,
  resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
})

export async function dashboardSecurityAlertRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── GET /dashboard/security-alerts — list (RLS-scoped) ──────────────────────────
  z4.get(
    '/security-alerts',
    {
      schema: {
        querystring: z.object({
          resolved: z.enum(['true', 'false']).optional(),
          severity: z.enum(['low', 'medium', 'high']).optional(),
          limit: z.coerce.number().int().positive().max(500).default(100),
        }),
        response: { 200: z.object({ alerts: z.array(AlertRow) }) },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const where: Record<string, unknown> = {}
      if (req.query.resolved !== undefined) where.resolved = req.query.resolved === 'true'
      if (req.query.severity) where.severity = req.query.severity
      const rows = await runInTenant<Row[]>(
        (tx: Tx) =>
          tx.securityAlert.findMany({
            where,
            select: ALERT_SELECT,
            orderBy: [{ resolved: 'asc' }, { createdAt: 'desc' }],
            take: req.query.limit,
          }) as PromiseLike<Row[]>,
        readOpts(id),
      )
      return reply.code(200).send({ alerts: rows.map(toRow) })
    },
  )

  // ── GET /dashboard/security-alerts/count — open-alert counts for the nav badge ──
  z4.get(
    '/security-alerts/count',
    { schema: { response: { 200: z.object({ open: z.number(), high: z.number() }) } } },
    async (req, reply) => {
      const id = req.identity!
      const [open, high] = await runInTenant<[number, number]>(async (tx: Tx) => {
        const o = await tx.securityAlert.count({ where: { resolved: false } })
        const h = await tx.securityAlert.count({ where: { resolved: false, severity: 'high' } })
        return [o, h]
      }, readOpts(id)) as [number, number]
      return reply.code(200).send({ open, high })
    },
  )

  // ── POST /dashboard/security-alerts/:id/resolve — mark resolved (RLS-scoped) ────
  z4.post(
    '/security-alerts/:id/resolve',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      // updateMany (not update) so RLS scopes the row set: a team-admin hitting
      // another team's alert id matches 0 rows → 404, never a cross-team write.
      const res = await runInTenant<{ count: number }>(
        (tx: Tx) =>
          tx.securityAlert.updateMany({
            where: { id: req.params.id, resolved: false },
            data: { resolved: true, resolvedAt: new Date() },
          }) as PromiseLike<{ count: number }>,
        writeOpts(id),
      )
      if (res.count === 0) return reply.code(404).send({ error: 'not_found' })
      return reply.code(200).send({ ok: true })
    },
  )
}
