/**
 * /dashboard/memories — the DASHBOARD memory-management plane (admin / super-admin).
 * requireAdmin (inherited from the /dashboard scope); per-row reach via decideDashboard.
 *
 * This is the ELEVATED surface (docs/internal/users_roles.md):
 *   • super-admin → CRUD any memory of ANY team (incl. a team-less super-admin,
 *     who CANNOT use the data-plane /memories/*).
 *   • team-admin  → CRUD any author's memory in their OWN team; other teams are
 *     read-only.
 *   • export / import — admin+, round-trippable JSON; imported rows remap stale
 *     source-environment team/user ids onto valid local control-plane rows.
 *
 * Reads are universal (RLS universal_read). Writes go through pm_app + runInTenant
 * with the global-admin path (super → any team; admin → own team) so RLS stays the
 * backstop. Plain members use the data-plane /memories/* instead (they never hit
 * this scope — requireAdmin rejects them).
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { makeEmbedderFromEnv, upsertVectors, type Embedder } from '@pm/shared'
import { ownerPrisma, runInTenant, Prisma, type Tx, type MemoryShape, type TenantCtx } from '@pm/db'
import { config } from '../../config.ts'
import { decideDashboard } from '../../authz/guards.ts'
import { assertNoPii } from '../../protocol/validation.ts'
import { qdrant, activePin, embedder as serverEmbedder, embeddingMode } from '../../services/embedding.ts'
import { withEmbeddingHealth } from '../../services/embedding-health.ts'
import { graphiti } from '../../services/graphiti.ts'
import {
  enqueueResolvedMemoryGraphRebuild,
  resolveMemoryGraphRebuildRequest,
} from '../../services/memory-graph-rebuild.ts'
import {
  graphSyncPendingPatch,
  postMemoryGraphEpisodeAndStamp,
} from '../../services/memory-graph-sync.ts'
import { sendBrowserPushNotification } from '../../services/browser-push.ts'
import { graphProjectGroup } from '../../services/graph-project-group.ts'
import { assertProjectMovePreservesGraphBoundary, enqueueGraphRemoval, graphDeletionPlanForSubject } from '../../services/graph-lifecycle.ts'
import { classifyMemoryUpdate } from '../../services/memory-update-routing.ts'

const SHAPE_VALUES = ['gotcha_fix', 'user_correction', 'tool_gap', 'prd', 'atomic'] as const
const MAX_IMPORT_ERROR_DETAILS = 100
type GraphRebuildFilters = { teamId?: string; project?: string; createdById?: string }

const AdminRow = z.object({
  revision: z.number().int().positive(), classification: z.unknown(), classificationStatus: z.string(), graphStatus: z.string(),
  id: z.string(),
  teamId: z.string(),
  content: z.string(),
  category: z.string(),
  shape: z.string(),
  entities: z.array(z.string()),
  project: z.string(),
  sessionId: z.string().nullable(),
  createdById: z.string().nullable(),
  embeddingStatus: z.string(),
  score: z.number().optional(),
  createdAt: z.string(),
  recordUpdatedAt: z.string(),
  updatedAt: z.string(),
  // Phase 9 provenance + lifecycle (surfaced for the dashboard badges/filters).
  memoryTier: z.string(),
  sourceProvenance: z.string(),
  confidence: z.number(),
  graphPrimary: z.boolean(),
  graphPrimaryFactCount: z.number(),
})

const MEM_SELECT = {
  revision: true, knowledge: true, graphStatus: true,
  id: true,
  teamId: true,
  content: true,
  category: true,
  shape: true,
  entities: true,
  project: true,
  sessionId: true,
  createdById: true,
  embeddingStatus: true,
  qdrantPointId: true,
  metadata: true,
  createdAt: true,
  recordUpdatedAt: true,
  updatedAt: true,
  memoryTier: true,
  sourceProvenance: true,
  confidence: true,
  graphGroupId: true,
  graphEpisodeId: true,
} as const

type MemRow = {
  revision: number; knowledge: unknown; graphStatus: string;
  id: string
  teamId: string
  content: string
  category: string
  shape: string
  entities: string[]
  project: string
  sessionId: string | null
  createdById: string | null
  embeddingStatus: string
  qdrantPointId: string | null
  metadata: unknown
  createdAt: Date
  recordUpdatedAt: Date
  updatedAt: Date
  memoryTier: string
  sourceProvenance: string
  confidence: number
  graphGroupId: string | null
  graphEpisodeId: string | null
}

type GraphPrimaryImpact = { primary: boolean; primaryFactCount: number }

function toRow(r: MemRow, score?: number, graphImpact: GraphPrimaryImpact = { primary: false, primaryFactCount: 0 }): z.infer<typeof AdminRow> {
  return {
    revision: r.revision, classification: r.knowledge, classificationStatus: r.knowledge ? 'classified' : 'legacy_unclassified', graphStatus: r.knowledge ? r.graphStatus : 'legacy_preserved',
    id: r.id,
    teamId: r.teamId,
    content: r.content,
    category: r.category,
    shape: r.shape,
    entities: r.entities,
    project: r.project,
    sessionId: r.sessionId,
    createdById: r.createdById,
    embeddingStatus: r.embeddingStatus,
    ...(score !== undefined ? { score } : {}),
    createdAt: r.createdAt.toISOString(),
    recordUpdatedAt: r.recordUpdatedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    memoryTier: r.memoryTier,
    sourceProvenance: r.sourceProvenance,
    confidence: r.confidence,
    graphPrimary: graphImpact.primary,
    graphPrimaryFactCount: graphImpact.primaryFactCount,
  }
}

/**
 * Graphiti's first episode is the owner of a derived fact. This is deliberately
 * a live read: provenance can shift as the graph evolves, so a persisted badge
 * would eventually lie. Callers that mutate must allow Graphiti failures to
 * propagate (fail closed); passive dashboard lists may degrade to no badge.
 */
async function graphPrimaryImpactByMemoryId(rows: Array<Pick<MemRow, 'id' | 'graphGroupId' | 'graphEpisodeId'>>): Promise<Map<string, GraphPrimaryImpact>> {
  const result = new Map<string, GraphPrimaryImpact>()
  const grouped = new Map<string, Array<Pick<MemRow, 'id' | 'graphGroupId' | 'graphEpisodeId'>>>()
  for (const row of rows) {
    if (!row.graphGroupId || !row.graphEpisodeId) continue
    grouped.set(row.graphGroupId, [...(grouped.get(row.graphGroupId) ?? []), row])
  }
  for (const [groupId, members] of grouped) {
    const impacts = await graphiti.episodeImpact({
      groupId,
      episodeIds: members.map((row) => row.graphEpisodeId!),
    })
    const byEpisode = new Map(impacts.map((impact) => [impact.episode_uuid, impact]))
    for (const row of members) {
      const primaryFactCount = byEpisode.get(row.graphEpisodeId!)?.primary_fact_count ?? 0
      result.set(row.id, { primary: primaryFactCount > 0, primaryFactCount })
    }
  }
  return result
}

async function graphPrimaryImpactForMemory(row: MemRow): Promise<GraphPrimaryImpact> {
  return (await graphPrimaryImpactByMemoryId([row])).get(row.id) ?? { primary: false, primaryFactCount: 0 }
}

async function graphDeletionPreviewForMemory(row: MemRow, tenantOpts: ReturnType<typeof readOpts>): Promise<{
  episodes: Array<{ groupId: string; episodeId: string }>
  primaryFactCount: number
}> {
  const episodes = await runInTenant(
    (tx: Tx) => graphDeletionPlanForSubject(tx, {
      subjectKind: 'memory',
      subjectId: row.id,
      current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
    }),
    tenantOpts,
  )
  const byGroup = new Map<string, typeof episodes>()
  for (const episode of episodes) byGroup.set(episode.groupId, [...(byGroup.get(episode.groupId) ?? []), episode])
  let primaryFactCount = 0
  for (const [groupId, members] of byGroup) {
    const impacts = await graphiti.episodeImpact({ groupId, episodeIds: members.map((member) => member.episodeId) })
    primaryFactCount += impacts.reduce((count, impact) => count + impact.primary_fact_count, 0)
  }
  return { episodes, primaryFactCount }
}

/** Cross-team read scope for the dashboard plane: ALL teams' memories
 *  (readAllMemory), incl. a team-less super-admin (globalAdmin). */
function readOpts(id: TenantCtx): { globalAdmin: boolean; readOnly: boolean; readAllMemory: boolean } {
  return { globalAdmin: id.isGlobalSuperuser, readOnly: true, readAllMemory: true }
}
/** Write scope targeting a specific team (super → any; admin → own, enforced upstream). */
function writeOpts(id: TenantCtx, teamId: string): { globalAdmin: boolean; teamIdOverride: string } {
  return { globalAdmin: id.isGlobalSuperuser, teamIdOverride: teamId }
}

/** A mode-independent embedder for dashboard re-embeds (import). Null if unbuildable. */
function dashboardEmbedder(): Embedder | null {
  if (serverEmbedder) return serverEmbedder
  try {
    return makeEmbedderFromEnv()
  } catch {
    return null
  }
}

function importErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message.trim()) return fallback
  return err.message.replace(/\s+/g, ' ').slice(0, 360)
}

async function teamExists(teamId: string | null | undefined): Promise<boolean> {
  if (!teamId) return false
  const team = await ownerPrisma.team.findUnique({ where: { id: teamId }, select: { id: true } })
  return team !== null
}

async function resolveImportTeamId(requestedTeamId: string | undefined, exportedTeamId: string | undefined, id: TenantCtx): Promise<string | null> {
  if (requestedTeamId && await teamExists(requestedTeamId)) return requestedTeamId
  if (!requestedTeamId && exportedTeamId && await teamExists(exportedTeamId)) return exportedTeamId
  if (id.teamId && await teamExists(id.teamId)) return id.teamId
  return null
}

async function resolveImportCreatedById(exportedCreatedById: string | null | undefined, fallbackUserId: string, targetTeam: string): Promise<string | null> {
  for (const candidate of [exportedCreatedById, fallbackUserId]) {
    if (!candidate) continue
    const user = await ownerPrisma.appUser.findUnique({ where: { id: candidate }, select: { id: true, teamId: true } })
    if (user?.teamId === targetTeam) return user.id
  }
  return null
}

export async function dashboardMemoryRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()
  const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })

  // ── GET /dashboard/memories — list (cross-team, filterable, keyset paginated) ────
  const ListQuery = z.object({
    teamId: z.string().uuid().optional(),
    project: z.string().optional(),
    category: z.string().optional(),
    shape: z.enum(SHAPE_VALUES).optional(),
    createdById: z.string().uuid().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    scoreMin: z.coerce.number().min(0).max(1).optional(),
    scoreMax: z.coerce.number().min(0).max(1).optional(),
  })
  z4.get(
    '/memories',
    {
      schema: {
        querystring: ListQuery,
        response: {
          200: z.object({
            results: z.array(AdminRow),
            nextCursor: z.string().nullable(),
            total: z.number(),
            badges: z.array(z.string()),
          }),
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const q = req.query
      const facetWhere: Prisma.MemoryWhereInput = {
        ...(q.teamId ? { teamId: q.teamId } : {}),
        ...(q.project ? { project: q.project } : {}),
        ...(q.shape ? { shape: q.shape as MemoryShape } : {}),
        ...(q.createdById ? { createdById: q.createdById } : {}),
        ...(q.scoreMin !== undefined || q.scoreMax !== undefined
          ? { confidence: { gte: q.scoreMin, lte: q.scoreMax } }
          : {}),
      }
      const filterWhere: Prisma.MemoryWhereInput = {
        ...facetWhere,
        ...(q.category ? { category: q.category } : {}),
      }
      const { rows, total, badges } = await runInTenant<{ rows: MemRow[]; total: number; badges: Array<{ category: string }> }>(
        async (tx: Tx) => {
          const rowsWhere: Prisma.MemoryWhereInput = {
            ...filterWhere,
          }
          const [rows, total, badges] = await Promise.all([
            tx.memory.findMany({
              where: rowsWhere,
              ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
              take: q.limit,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: MEM_SELECT,
            }) as PromiseLike<MemRow[]>,
            tx.memory.count({ where: filterWhere }),
            tx.memory.findMany({
              where: facetWhere,
              distinct: ['category'],
              orderBy: { category: 'asc' },
              select: { category: true },
            }) as PromiseLike<Array<{ category: string }>>,
          ])
          return { rows, total, badges }
        },
        readOpts(id),
      )
      const nextCursor = rows.length === q.limit ? (rows[rows.length - 1]?.id ?? null) : null
      const primary = await graphPrimaryImpactByMemoryId(rows).catch((err) => {
        req.log.warn({ err }, 'graph-primary impact unavailable; omitting passive dashboard badges')
        return new Map<string, GraphPrimaryImpact>()
      })
      return reply.code(200).send({
        results: rows.map((r) => toRow(r, undefined, primary.get(r.id))),
        nextCursor,
        total,
        badges: badges.map((row) => row.category),
      })
    },
  )

  // ── GET /dashboard/memories/pending — counts of rows awaiting embedding ──────────
  // The backfill (worker scheduled job 'embed-backfill') consumes these in server-managed embeddings;
  // in client-managed embeddings the MCP client bridge does. Cross-team dashboard read (readOpts).
  z4.get(
    '/memories/pending',
    {
      schema: {
        response: {
          200: z.object({ memories: z.number(), chunks: z.number(), embeddingMode: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const counts = await runInTenant<{ memories: number; chunks: number }>(
        async (tx: Tx) => ({
          memories: await tx.memory.count({ where: { embeddingStatus: 'pending' } }),
          chunks: await tx.chunk.count({ where: { embeddingStatus: 'pending' } }),
        }),
        readOpts(id),
      )
      return reply.code(200).send({ ...counts, embeddingMode })
    },
  )

  // ── POST /dashboard/memories/graph/rebuild — one-time Memory → Graphiti replay ──
  const GraphRebuildBody = z
    .object({
      teamId: z.string().uuid().optional(),
      project: z.string().min(1).optional(),
      createdById: z.string().uuid().optional(),
    })
    .strict()
  z4.post(
    '/memories/graph/rebuild',
    {
      schema: {
        body: GraphRebuildBody,
        response: {
          202: z.object({
            jobId: z.string(),
            matched: z.number(),
            filters: z.object({
              teamId: z.string().optional(),
              project: z.string().optional(),
              createdById: z.string().optional(),
            }),
          }),
          403: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      let filters: GraphRebuildFilters
      try {
        ;({ filters } = resolveMemoryGraphRebuildRequest(id, req.body))
      } catch (err) {
        return reply.code(403).send({ error: 'forbidden', message: err instanceof Error ? err.message : String(err) })
      }
      const where = {
        ...(filters.teamId ? { teamId: filters.teamId } : {}),
        ...(filters.project ? { project: filters.project } : {}),
        ...(filters.createdById ? { createdById: filters.createdById } : {}),
      }
      const matched = await runInTenant<number>(
        (tx: Tx) => tx.memory.count({ where }),
        readOpts(id),
      )
      const jobId = await enqueueResolvedMemoryGraphRebuild({
        requestedById: id.userId,
        filters,
      })
      return reply.code(202).send({ jobId, matched, filters })
    },
  )

  // ── POST /dashboard/memories/search — dashboard search (exact first, semantic fallback)
  const SearchBody = z
    .object({
      query: z.string().min(1).optional(),
      queryVector: z.array(z.number()).optional(),
      teamId: z.string().uuid().optional(),
      project: z.string().min(1).optional(),
      category: z.string().optional(),
      scoreMin: z.coerce.number().min(0).max(1).optional(),
      scoreMax: z.coerce.number().min(0).max(1).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict()
    .refine((b) => b.query || b.queryVector, { message: 'query or queryVector required' })
  z4.post(
    '/memories/search',
    {
      schema: {
        body: SearchBody,
        response: { 200: z.object({ results: z.array(AdminRow), total: z.number() }), 400: ErrorBody, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const body = req.body
      const baseWhere: Prisma.MemoryWhereInput = {
        ...(body.teamId ? { teamId: body.teamId } : {}),
        ...(body.project ? { project: body.project } : {}),
        ...(body.category ? { category: body.category } : {}),
        ...(body.scoreMin !== undefined || body.scoreMax !== undefined
          ? { confidence: { gte: body.scoreMin, lte: body.scoreMax } }
          : {}),
      }
      const literalQuery = body.query?.trim()
      if (literalQuery) {
        const exactWhere: Prisma.MemoryWhereInput = {
          ...baseWhere,
          OR: [
            { content: { contains: literalQuery, mode: 'insensitive' } },
            { project: { contains: literalQuery, mode: 'insensitive' } },
            { category: { contains: literalQuery, mode: 'insensitive' } },
            { entities: { has: literalQuery } },
          ],
        }
        const exact = await runInTenant<{ rows: MemRow[]; total: number }>(
          async (tx: Tx) => {
            const [rows, total] = await Promise.all([
              tx.memory.findMany({
                where: exactWhere,
                take: body.limit,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: MEM_SELECT,
              }) as PromiseLike<MemRow[]>,
              tx.memory.count({ where: exactWhere }),
            ])
            return { rows, total }
          },
          readOpts(id),
        )
        if (exact.total > 0) {
          return reply.code(200).send({ results: exact.rows.map((r) => toRow(r)), total: exact.total })
        }
      }
      // Embed the query (mode-independent for the dashboard surface).
      let queryVector: number[]
      if (body.queryVector) {
        if (body.queryVector.length !== activePin.dim) {
          return reply.code(422).send({ error: 'vector_dim_mismatch', message: `dim ${body.queryVector.length} != ${activePin.dim}` })
        }
        queryVector = body.queryVector
      } else {
        const emb = dashboardEmbedder()
        if (!emb) return reply.code(400).send({ error: 'no_embedder', message: 'No embedder available to embed the query.' })
        const out = await withEmbeddingHealth(
          { observerScope: 'server', provider: emb.provider, model: emb.model },
          () => emb.embed([body.query!], 'query'),
        )
        const v = out.vectors[0]
        if (!v) return reply.code(400).send({ error: 'embed_failed' })
        queryVector = v
      }
      // Qdrant universal fan-out → hydrate under RLS (universal_read).
      const { searchVectors } = await import('@pm/shared')
      const hits = await searchVectors(qdrant, { queryVector, pin: activePin, allTeams: true, sourceKind: 'memory', limit: body.limit, ...(body.project ? { project: body.project } : {}) })
      if (hits.length === 0) return reply.code(200).send({ results: [], total: 0 })
      const rowIds = hits.map((h) => h.rowId).filter((x) => x.length > 0)
      const rows = await runInTenant<MemRow[]>(
        (tx: Tx) => tx.memory.findMany({ where: { id: { in: rowIds }, ...baseWhere }, select: MEM_SELECT }) as PromiseLike<MemRow[]>,
        readOpts(id),
      )
      const byId = new Map(rows.map((r) => [r.id, r]))
      const results = hits
        .map((h) => {
          const r = byId.get(h.rowId)
          return r ? toRow(r, h.score) : null
        })
        .filter((x): x is z.infer<typeof AdminRow> => x !== null)
      return reply.code(200).send({ results, total: results.length })
    },
  )

  // ── GET /dashboard/memories/:id ─────────────────────────────────────────────────
  const IdParam = z.object({ id: z.string().uuid() })
  z4.get(
    '/memories/:id',
    { schema: { params: IdParam, response: { 200: AdminRow, 404: z.object({ error: z.string() }) } } },
    async (req, reply) => {
      const id = req.identity!
      const row = await runInTenant<MemRow | null>(
        (tx: Tx) => tx.memory.findUnique({ where: { id: req.params.id }, select: MEM_SELECT }) as PromiseLike<MemRow | null>,
        readOpts(id),
      )
      if (!row) return reply.code(404).send({ error: 'not_found' })
      const primary = await graphPrimaryImpactByMemoryId([row]).catch((err) => {
        req.log.warn({ err, id: row.id }, 'graph-primary impact unavailable; omitting passive dashboard badge')
        return new Map<string, GraphPrimaryImpact>()
      })
      return reply.code(200).send(toRow(row, undefined, primary.get(row.id)))
    },
  )

  // ── DELETE /dashboard/memories/:id — preview token then consume ────────────────
  const DeletePreview = z.object({
    token: z.string().uuid(),
    primaryFactCount: z.number(),
    episodeCount: z.number(),
    expiresAt: z.string(),
  })
  z4.post(
    '/memories/:id/delete-preview',
    { schema: { params: IdParam, response: { 200: DeletePreview, 403: ErrorBody, 404: z.object({ error: z.string() }) } } },
    async (req, reply) => {
      const id = req.identity!
      const row = await runInTenant<MemRow | null>(
        (tx: Tx) => tx.memory.findUnique({ where: { id: req.params.id }, select: MEM_SELECT }) as PromiseLike<MemRow | null>,
        readOpts(id),
      )
      if (!row) return reply.code(404).send({ error: 'not_found' })
      const decision = decideDashboard({ identity: id, action: 'delete', target: { teamId: row.teamId, createdById: row.createdById } })
      if (!decision.ok) throw decision.error
      const preview = await graphDeletionPreviewForMemory(row, readOpts(id))
      const token = randomUUID()
      const expiresAt = new Date(Date.now() + 5 * 60_000)
      await runInTenant(
        (tx: Tx) => tx.graphDeletePreview.create({
          data: {
            token,
            teamId: row.teamId,
            requestedById: id.userId,
            subjectKind: 'memory',
            subjectId: row.id,
            subjectUpdatedAt: row.updatedAt,
            episodes: preview.episodes,
            impact: { primaryFactCount: preview.primaryFactCount },
            expiresAt,
          },
        }),
        writeOpts(id, row.teamId),
      )
      return reply.code(200).send({ token, primaryFactCount: preview.primaryFactCount, episodeCount: preview.episodes.length, expiresAt: expiresAt.toISOString() })
    },
  )

  const DashboardDeleteBody = z.object({ previewToken: z.string().uuid() }).strict()
  const PreviewRequired = z.object({ error: z.literal('graph_delete_preview_required'), message: z.string() })
  z4.delete(
    '/memories/:id',
    { schema: { params: IdParam, body: DashboardDeleteBody, response: { 204: z.null(), 403: ErrorBody, 404: z.object({ error: z.string() }), 409: PreviewRequired } } },
    async (req, reply) => {
      const id = req.identity!
      const row = await runInTenant<MemRow | null>(
        (tx: Tx) => tx.memory.findUnique({ where: { id: req.params.id }, select: MEM_SELECT }) as PromiseLike<MemRow | null>,
        readOpts(id),
      )
      if (!row) return reply.code(404).send({ error: 'not_found' })
      const decision = decideDashboard({ identity: id, action: 'delete', target: { teamId: row.teamId, createdById: row.createdById } })
      if (!decision.ok) throw decision.error
      const livePreview = await graphDeletionPreviewForMemory(row, readOpts(id))
      const liveEpisodeKey = JSON.stringify(livePreview.episodes)
      const consumed = await runInTenant(async (tx: Tx) => {
        const preview = await tx.graphDeletePreview.findUnique({ where: { token: req.body.previewToken } })
        if (!preview || preview.requestedById !== id.userId || preview.subjectKind !== 'memory' || preview.subjectId !== row.id || preview.teamId !== row.teamId || preview.consumedAt || preview.expiresAt <= new Date() || preview.subjectUpdatedAt.getTime() !== row.updatedAt.getTime() || JSON.stringify(preview.episodes) !== liveEpisodeKey) return false
        const deleted = await tx.memory.deleteMany({ where: { id: row.id, updatedAt: row.updatedAt } })
        if (deleted.count !== 1) return false
        await tx.graphDeletePreview.update({ where: { id: preview.id }, data: { consumedAt: new Date() } })
        await enqueueGraphRemoval(tx, {
          teamId: row.teamId,
          project: row.project,
          subjectKind: 'memory',
          subjectId: row.id,
          current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
        })
        return true
      }, writeOpts(id, row.teamId))
      if (!consumed) {
        return reply.code(409).send({
          error: 'graph_delete_preview_required',
          message: 'The deletion preview is expired, already used, or stale. Review the current graph impact and confirm again.',
        })
      }
      if (row.qdrantPointId) {
        await qdrant.delete('memory_vectors', { points: [row.qdrantPointId] }).catch((err) => req.log.warn({ err }, 'qdrant delete failed (non-fatal)'))
      }
      void sendBrowserPushNotification({
        type: 'memoryRemoved',
        teamId: row.teamId,
        userId: id.userId,
        title: 'Memory removed',
        body: 'A personal memory was removed.',
        url: '/memories',
      }).catch((err) => req.log.warn({ err, id: row.id }, 'browser push dashboard memory-removed notification failed'))
      return reply.code(204).send(null)
    },
  )

}
