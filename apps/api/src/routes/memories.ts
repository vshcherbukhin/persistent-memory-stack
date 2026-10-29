/**
 * persistent-memory-api — agent-memory endpoints (Phase 7). These map 1:1 to the
 * P8 MCP tools (add_memory, search_memories, search_memories_by_entities,
 * get_memories, get_memory, update_memory, delete_memory, delete_all_memories,
 * list_entities).
 *
 * MANDATORY PROTOCOL (enforced here):
 *   • team/user/role come from req.identity (the token) — NEVER the body. Every
 *     Zod body is .strict() and OMITS team/teamId/user/role; a body that sends
 *     teamId gets a 400, backstopped by RLS WITH CHECK team_id = own.
 *   • project defaults to "general" (z.string().min(1).default("general")) — so
 *     it is always present on every write even when the body omits it; the same
 *     literal is also the Prisma default. The "agent must name its project"
 *     nudge is enforced client-side by the P8 MCP, not by making this required.
 *   • session_id optional, carried.
 *   • content + Shape fields run the validateAndRoute gate → 422 on reject.
 *
 * ORDERING DISCIPLINE (mirrors /ingest): validate → row write (tx) → Qdrant
 * upsert (AFTER the row, so no dangling vector) → Graphiti episode (best-effort,
 * last, never fails the write).
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { upsertVectors, assertActivePin, KnowledgeFilters, type SearchHit } from '@pm/shared'
import { runInTenant, getCtx, Prisma, type Tx, type MemoryShape, type TenantCtx } from '@pm/db'
import { requireTeamMember, decideDataPlane, allowUniversalRead } from '../authz/guards.ts'
import { validateAndRoute, type WriteMetadata } from '../protocol/validation.ts'
import { deriveProvenance, defaultConfidence, deriveTier, type MemoryTierValue } from '../protocol/shapes.ts'
import { embedder, qdrant, activePin } from '../services/embedding.ts'
import { withEmbeddingHealth } from '../services/embedding-health.ts'
import { graphiti } from '../services/graphiti.ts'
import { searchMemoriesMerged, partitionOwnFirst } from '../services/merge.ts'
import {
  graphSyncPendingPatch,
  postMemoryGraphEpisodeAndStamp,
} from '../services/memory-graph-sync.ts'
import { sendBrowserPushNotification } from '../services/browser-push.ts'
import { graphProjectGroup } from '../services/graph-project-group.ts'
import { assertProjectMovePreservesGraphBoundary, enqueueGraphRemoval, graphDeletionPlanForSubject } from '../services/graph-lifecycle.ts'
import { classifyMemoryUpdate } from '../services/memory-update-routing.ts'
import { knowledgeWhere } from '../services/knowledge.ts'

const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })

// ── Shared Zod pieces ─────────────────────────────────────────────────────
const Metadata = z
  .object({
    category: z.enum([
      'gotcha',
      'fix',
      'user-correction',
      'tool-gap',
      'prd',
      'migration-pattern',
      'data-constraint',
      'permission',
      'flag-state',
    ]),
    entities: z.array(z.string()).min(1),
    source: z.enum([
      'gotcha-discovered',
      'user-correction',
      'postmortem',
      'confluence',
      'test-failure',
      'heal-cycle',
    ]),
    severity: z.enum(['high', 'medium', 'low']).optional(),
    epic: z.string().optional(),
    feature: z.string().optional(),
    pageId: z.string().optional(),
    confluenceUrl: z.string().optional(),
    // Phase 9: the agent may CLASSIFY the tier (low-risk). Provenance + confidence
    // are SERVER-determined (provenance from source, confidence from the LLM) — an
    // agent must NOT be able to self-assert human_verified / high confidence, which
    // would defeat the rerank's memory-injection-safety gate.
    tier: z.enum(['semantic', 'episodic', 'procedural', 'working']).optional(),
  })
  .strict()

const ResultRow = z.object({
  revision: z.number().int().positive(), classification: z.unknown(), classificationStatus: z.string(),
  embeddingStatus: z.string(), graphStatus: z.string(), relationshipExplanations: z.array(z.string()).optional(),
  id: z.string(),
  content: z.string(),
  category: z.string(),
  shape: z.string(),
  entities: z.array(z.string()),
  project: z.string(),
  sessionId: z.string().nullable(),
  createdById: z.string().nullable(),
  score: z.number().optional(),
  sourceTeam: z.string(),
  isOwnTeam: z.boolean(),
  createdAt: z.string(),
  recordUpdatedAt: z.string(),
  // Phase 9 provenance (semantic search populates these; the non-vector list
  // endpoints omit them — hence optional). They let the agent weigh trust.
  memoryTier: z.string().optional(),
  sourceProvenance: z.string().optional(),
  confidence: z.number().optional(),
})

/** The closed MemoryShape strings (for list filtering + responses). */
const SHAPE_VALUES = ['gotcha_fix', 'user_correction', 'tool_gap', 'prd', 'atomic'] as const

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── POST /memories/search — search_memories (the cross-team merge) ─────────
  const SearchBody = z
    .object({
      ...KnowledgeFilters.shape,
      contextHints: z.object({ projects: z.array(z.string()).max(20).optional(), topics: z.array(z.string()).max(20).optional() }).strict().optional(),
      query: z.string().min(1).optional(),
      queryVector: z.array(z.number()).optional(), // client-managed embeddings
      project: z.string().min(1).optional(),
      category: z.string().optional(),
      scoreMin: z.coerce.number().min(0).max(1).optional(),
      scoreMax: z.coerce.number().min(0).max(1).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      // Dashboard universal read (all teams) — HONORED ONLY for admin+ callers.
      // A plain member's universal:true is ignored → own ∪ mounted. The MCP omits it.
      universal: z.boolean().optional(),
    })
    .strict()
    .refine((b) => b.query || b.queryVector, {
      message: 'query (server-managed embeddings) or queryVector (client-managed embeddings) is required',
    })

  z4.post(
    '/memories/search',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: SearchBody,
        response: {
          200: z.object({
            results: z.array(ResultRow),
            counts: z.object({ own: z.number(), other: z.number() }),
            diagnostics: z.object({ semantic: z.string(), lexical: z.string(), graphExpansion: z.string() }),
          }),
          400: ErrorBody,
          422: ErrorBody,
          500: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const body = req.body
      const id = req.identity!

      let queryVector = body.queryVector
      if (embedder && body.query) {
        try {
          const serverEmbedder = embedder
          const out = await withEmbeddingHealth({ observerScope: 'server', provider: serverEmbedder.provider, model: serverEmbedder.model }, () => serverEmbedder.embed([body.query!], 'query'))
          queryVector = out.vectors[0]
        } catch (error) { req.log.warn({ err: error }, 'semantic query unavailable; lexical retrieval remains available') }
      }
      if (queryVector && queryVector.length !== activePin.dim) return reply.code(422).send({ error: 'vector_dim_mismatch', message: 'Use the current embedding pin.' })
      const merged = await searchMemoriesMerged(qdrant, {
        ...body, queryVector,
        pin: activePin,
        ...(body.project ? { project: body.project } : {}),
        ...(body.category ? { category: body.category } : {}),
        ...(body.scoreMin !== undefined ? { scoreMin: body.scoreMin } : {}),
        ...(body.scoreMax !== undefined ? { scoreMax: body.scoreMax } : {}),
        limit: body.limit,

      })
      return reply.code(200).send(merged)
    },
  )

  // ── POST /memories/search-by-entities — search_memories_by_entities ────────
  const ByEntitiesBody = z
    .object({
      entities: z.array(z.string()).min(1),
      mode: z.enum(['any', 'all']).default('any'),
      project: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict()

  z4.post(
    '/memories/search-by-entities',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: ByEntitiesBody,
        response: {
          200: z.object({ results: z.array(ResultRow) }),
          400: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const body = req.body
      const rows = await runInTenant<MemRow[]>(
        (tx: Tx) =>
          tx.memory.findMany({
            where: {
              ...knowledgeWhere(body),
              entities:
                body.mode === 'all'
                  ? { hasEvery: body.entities }
                  : { hasSome: body.entities },

            },
            take: body.limit,
            orderBy: { createdAt: 'desc' },
            select: MEM_SELECT,
          }) as PromiseLike<MemRow[]>,
      )
      return reply.code(200).send({ results: toResultRows(partitionOwnFirst(rows)) })
    },
  )

  // ── GET /memories — get_memories (list, keyset paginated, RLS) ─────────────
  const ListQuery = z.object({
    ...KnowledgeFilters.shape,
    project: z.string().optional(),
    category: z.string().optional(),
    sessionId: z.string().optional(),
    shape: z.enum(SHAPE_VALUES).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    scoreMin: z.coerce.number().min(0).max(1).optional(),
    scoreMax: z.coerce.number().min(0).max(1).optional(),
    // Universal read (all teams) — admin+ only (gated below). The MCP omits it,
    // and a member's universal:true is ignored → own ∪ mounted.
    universal: z.coerce.boolean().optional(),
  })

  z4.get(
    '/memories',
    {
      preHandler: [requireTeamMember],
      schema: {
        querystring: ListQuery,
        response: {
          200: z.object({
            results: z.array(ResultRow),
            nextCursor: z.string().nullable(),
            total: z.number(),
            badges: z.array(z.string()),
          }),
        },
      },
    },
    async (req, reply) => {
      const q = req.query
      const id = req.identity!
      // Universal (all-teams) list is admin-only; a plain member's `universal:true`
      // is IGNORED → own ∪ mounted (mirrors POST /memories/search). Without this
      // gate a member could set app.read_all_memory via ?universal=true and read
      // every team's memories through the RLS pm_read_all_memory() path.
      const universal = allowUniversalRead(id.adminLevel, q.universal)
      const facetWhere: Prisma.MemoryWhereInput = {
        ...knowledgeWhere(q),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
        ...(q.shape ? { shape: q.shape as MemoryShape } : {}),
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
          const [rows, total, badges] = await Promise.all([
            tx.memory.findMany({
              where: filterWhere,
              ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
              take: q.limit,
              // Keyset on (createdAt desc, id desc); cursor = last id.
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
        universal ? { readAllMemory: true } : {},
      )
      const nextCursor = rows.length === q.limit ? (rows[rows.length - 1]?.id ?? null) : null
      return reply.code(200).send({ results: toResultRows(rows), nextCursor, total, badges: badges.map((row) => row.category) })
    },
  )

  // ── GET /memories/:id — get_memory (RLS; unreadable → 404) ─────────────────
  const IdParam = z.object({ id: z.string().uuid() })

  z4.get(
    '/memories/:id',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: IdParam,
        response: { 200: ResultRow, 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const row = await runInTenant<MemRow | null>(
        (tx: Tx) =>
          tx.memory.findUnique({
            where: { id: req.params.id },
            select: MEM_SELECT,
          }) as PromiseLike<MemRow | null>,
      )
      if (!row) return reply.code(404).send({ error: 'not_found' })
      return reply.code(200).send(toResultRow(row))
    },
  )

  // ── DELETE /memories/:id — delete_memory (own-team RLS; 0 rows → 404) ───────
  z4.delete(
    '/memories/:id',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: IdParam,
        response: {
          204: z.null(),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.literal('primary_graph_delete_forbidden'), message: z.string(), primaryFactCount: z.number() }),
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      // Read the row (universal) to authorize + capture the pointId for purge.
      const row = await runInTenant<{
        teamId: string
        project: string
        createdById: string | null
        qdrantPointId: string | null
        graphGroupId: string | null
        graphEpisodeId: string | null
        updatedAt: Date
      } | null>(
        (tx: Tx) =>
          tx.memory.findUnique({
            where: { id: req.params.id },
            select: { teamId: true, project: true, createdById: true, qdrantPointId: true, graphGroupId: true, graphEpisodeId: true, updatedAt: true },
          }) as PromiseLike<{
            teamId: string
            project: string
            createdById: string | null
            qdrantPointId: string | null
            graphGroupId: string | null
            graphEpisodeId: string | null
            updatedAt: Date
          } | null>,
      )
      if (!row) return reply.code(404).send({ error: 'not_found' })

      // Per-row authorization (current-team + ownership). Backstopped by RLS.
      const decision = decideDataPlane({
        identity: id,
        action: 'delete',
        target: { teamId: row.teamId, createdById: row.createdById },
      })
      if (!decision.ok) throw decision.error

      // An agent must never delete a Graphiti primary. The dashboard is the
      // only surface that can make the explicit, authorized cascade decision.
        const graphEpisodes = await runInTenant(
        (tx: Tx) => graphDeletionPlanForSubject(tx, {
          subjectKind: 'memory', subjectId: req.params.id,
          current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
        }),
      )
      let primaryFactCount = 0
      const graphEpisodesByGroup = new Map<string, typeof graphEpisodes>()
      for (const episode of graphEpisodes) graphEpisodesByGroup.set(episode.groupId, [...(graphEpisodesByGroup.get(episode.groupId) ?? []), episode])
      for (const [groupId, episodeIds] of graphEpisodesByGroup) {
        const impacts = await graphiti.episodeImpact({ groupId, episodeIds: episodeIds.map((episode) => episode.episodeId) })
        primaryFactCount += impacts.reduce((count, impact) => count + impact.primary_fact_count, 0)
      }
      if (primaryFactCount > 0) {
        return reply.code(409).send({
          error: 'primary_graph_delete_forbidden',
          message: `Memory ${req.params.id} is a primary graph source for ${primaryFactCount} fact(s). Use the dashboard's confirmed admin deletion flow for a cascade.`,
          primaryFactCount,
        })
      }

      const deleted = await runInTenant<{ count: number }>(async (tx: Tx) => {
        // Condition the row deletion on the version we preflighted. Only queue
        // removal after that exact row is gone, inside the same transaction.
        const deleted = await tx.memory.deleteMany({ where: { id: req.params.id, updatedAt: row.updatedAt } })
        if (deleted.count === 0) return deleted
        await enqueueGraphRemoval(tx, {
          teamId: row.teamId, project: row.project, subjectKind: 'memory', subjectId: req.params.id,
          current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
        })
        return deleted
      })
      if (deleted.count === 0) return reply.code(404).send({ error: 'not_found' })

      if (row?.qdrantPointId) {
        await qdrant
          .delete('memory_vectors', { points: [row.qdrantPointId] })
          .catch((err) => req.log.warn({ err }, 'qdrant point delete failed (non-fatal)'))
      }
      void sendBrowserPushNotification({
        type: 'memoryRemoved',
        teamId: row.teamId,
        userId: id.userId,
        title: 'Memory removed',
        body: 'A personal memory was removed.',
        url: '/memories',
      }).catch((err) => req.log.warn({ err, id: req.params.id }, 'browser push memory-removed notification failed'))
      return reply.code(204).send(null)
    },
  )

  // ── Dashboard bulk delete: live graph-impact preview → one-time consume ────
  // This deliberately has a distinct path from DELETE /memories below. The latter
  // remains the MCP/agent bulk operation and continues to refuse every primary
  // graph source. The dashboard flow lets a Personal owner or Shared team admin
  // make an explicit human confirmation after seeing the aggregate cascade.
  const BulkScopeBody = z.object({ project: z.string().min(1).optional() }).strict()
  const BulkDeletePreview = z.object({
    token: z.string().uuid(),
    memoryCount: z.number(),
    episodeCount: z.number(),
    primaryMemoryCount: z.number(),
    primaryFactCount: z.number(),
    canConfirmPrimary: z.boolean(),
    expiresAt: z.string(),
  })
  const BulkDeleteExecuteBody = z.object({ previewToken: z.string().uuid() }).strict()
  const BulkSnapshot = z.array(z.object({
    id: z.string().uuid(),
    project: z.string(),
    updatedAt: z.string(),
    qdrantPointId: z.string().uuid().nullable(),
    graphGroupId: z.string().nullable(),
    graphEpisodeId: z.string().nullable(),
    episodes: z.array(z.object({ groupId: z.string(), episodeId: z.string() })),
    primaryFactCount: z.number(),
  }))
  const BulkImpact = z.object({
    kind: z.literal('bulk_memory_delete'),
    primaryMemoryIds: z.array(z.string().uuid()),
    primaryFactCount: z.number(),
  })
  type BulkRow = {
    id: string
    project: string
    qdrantPointId: string | null
    graphGroupId: string | null
    graphEpisodeId: string | null
    updatedAt: Date
  }
  type BulkSnapshotRow = z.infer<typeof BulkSnapshot>[number]

  const bulkScope = (identity: TenantCtx, project?: string) => ({
    teamId: identity.teamId!,
    ...(project ? { project } : {}),
    ...(identity.isTeamAdmin || identity.isGlobalSuperuser ? {} : { createdById: identity.userId }),
  })

  async function graphPreviewForBulkRows(rows: BulkRow[]): Promise<BulkSnapshotRow[]> {
    const plans = new Map<string, Array<{ groupId: string; episodeId: string }>>()
    const rowsByGroup = new Map<string, BulkRow[]>()
    for (const row of rows) {
      const episodes = await runInTenant((tx: Tx) => graphDeletionPlanForSubject(tx, {
        subjectKind: 'memory',
        subjectId: row.id,
        current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
      }))
      plans.set(row.id, episodes)
      for (const episode of episodes) rowsByGroup.set(episode.groupId, [...(rowsByGroup.get(episode.groupId) ?? []), row])
    }

    const primaryByMemory = new Map<string, number>()
    for (const [groupId, groupRows] of rowsByGroup) {
      const episodeIds = [...new Set(groupRows.flatMap((row) => plans.get(row.id) ?? []).filter((episode) => episode.groupId === groupId).map((episode) => episode.episodeId))]
      const impacts = await graphiti.episodeImpact({ groupId, episodeIds })
      const byEpisode = new Map(impacts.map((impact) => [impact.episode_uuid, impact.primary_fact_count]))
      for (const row of groupRows) {
        const primaryFactCount = (plans.get(row.id) ?? [])
          .filter((episode) => episode.groupId === groupId)
          .reduce((count, episode) => count + (byEpisode.get(episode.episodeId) ?? 0), 0)
        primaryByMemory.set(row.id, (primaryByMemory.get(row.id) ?? 0) + primaryFactCount)
      }
    }

    return rows
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        project: row.project,
        updatedAt: row.updatedAt.toISOString(),
        qdrantPointId: row.qdrantPointId,
        graphGroupId: row.graphGroupId,
        graphEpisodeId: row.graphEpisodeId,
        episodes: plans.get(row.id) ?? [],
        primaryFactCount: primaryByMemory.get(row.id) ?? 0,
      }))
  }

  z4.post(
    '/memories/bulk-delete-preview',
    {
      preHandler: [requireTeamMember],
      schema: { body: BulkScopeBody, response: { 200: BulkDeletePreview, 400: ErrorBody } },
    },
    async (req, reply) => {
      const id = req.identity!
      const rows = await runInTenant<BulkRow[]>((tx: Tx) =>
        tx.memory.findMany({
          where: bulkScope(id, req.body.project),
          select: { id: true, project: true, qdrantPointId: true, graphGroupId: true, graphEpisodeId: true, updatedAt: true },
        }) as PromiseLike<BulkRow[]>,
      )
      const snapshot = await graphPreviewForBulkRows(rows)
      const primaryMemoryIds = snapshot.filter((row) => row.primaryFactCount > 0).map((row) => row.id)
      const primaryFactCount = snapshot.reduce((count, row) => count + row.primaryFactCount, 0)
      const token = randomUUID()
      const expiresAt = new Date(Date.now() + 5 * 60_000)
      await runInTenant((tx: Tx) => tx.graphDeletePreview.create({
        data: {
          token,
          teamId: id.teamId!,
          requestedById: id.userId,
          // A bulk preview belongs to its current team rather than one Memory row.
          // The full, immutable selected-row snapshot remains in `episodes`.
          subjectKind: 'memory',
          subjectId: id.teamId!,
          subjectUpdatedAt: new Date(),
          episodes: snapshot,
          impact: { kind: 'bulk_memory_delete', primaryMemoryIds, primaryFactCount },
          expiresAt,
        },
      }))
      return reply.code(200).send({
        token,
        memoryCount: snapshot.length,
        episodeCount: snapshot.reduce((count, row) => count + row.episodes.length, 0),
        primaryMemoryCount: primaryMemoryIds.length,
        primaryFactCount,
        canConfirmPrimary: id.isTeamAdmin || id.isGlobalSuperuser,
        expiresAt: expiresAt.toISOString(),
      })
    },
  )

  z4.delete(
    '/memories/bulk',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: BulkDeleteExecuteBody,
        response: {
          200: z.object({ deleted: z.number() }),
          403: ErrorBody,
          409: z.object({ error: z.literal('bulk_graph_delete_preview_required'), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const preview = await runInTenant((tx: Tx) => tx.graphDeletePreview.findUnique({ where: { token: req.body.previewToken } }))
      const stale = () => reply.code(409).send({
        error: 'bulk_graph_delete_preview_required' as const,
        message: 'The bulk deletion preview is expired, already used, or stale. Review the current graph impact and confirm again.',
      })
      if (!preview || preview.requestedById !== id.userId || preview.teamId !== id.teamId || preview.subjectKind !== 'memory' || preview.subjectId !== id.teamId || preview.consumedAt || preview.expiresAt <= new Date()) return stale()

      const expected = BulkSnapshot.safeParse(preview.episodes)
      const impact = BulkImpact.safeParse(preview.impact)
      if (!expected.success || !impact.success) return stale()

      const rows = await runInTenant<BulkRow[]>((tx: Tx) =>
        tx.memory.findMany({
          where: {
            teamId: id.teamId!,
            id: { in: expected.data.map((row) => row.id) },
            ...(id.isTeamAdmin || id.isGlobalSuperuser ? {} : { createdById: id.userId }),
          },
          select: { id: true, project: true, qdrantPointId: true, graphGroupId: true, graphEpisodeId: true, updatedAt: true },
        }) as PromiseLike<BulkRow[]>,
      )
      const live = await graphPreviewForBulkRows(rows)
      if (JSON.stringify(live) !== JSON.stringify(expected.data)) return stale()
      if (impact.data.primaryMemoryIds.length > 0 && !(id.isTeamAdmin || id.isGlobalSuperuser)) {
        return reply.code(403).send({
          error: 'primary_graph_bulk_delete_admin_required',
          message: 'A Shared team member cannot delete graph-primary memories. Ask a team admin to review and confirm the cascade.',
        })
      }

      try {
        const deletedRows = await runInTenant(async (tx: Tx) => {
          // Claim the token before deleting. This conditional write also makes an
          // empty selection single-use: there may be no Memory row deletion to
          // serialize two concurrent confirmation requests in that case.
          const claimed = await tx.graphDeletePreview.updateMany({
            where: { id: preview.id, consumedAt: null, expiresAt: { gt: new Date() } },
            data: { consumedAt: new Date() },
          })
          if (claimed.count !== 1) throw new Error('bulk_preview_stale')
          for (const row of live) {
            const deleted = await tx.memory.deleteMany({ where: { id: row.id, teamId: id.teamId!, updatedAt: new Date(row.updatedAt) } })
            if (deleted.count !== 1) throw new Error('bulk_preview_stale')
            await enqueueGraphRemoval(tx, {
              teamId: id.teamId!,
              project: row.project,
              subjectKind: 'memory',
              subjectId: row.id,
              current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
            })
          }
          return live
        })
        const pointIds = deletedRows.map((row) => row.qdrantPointId).filter((pointId): pointId is string => !!pointId)
        if (pointIds.length > 0) {
          await qdrant.delete('memory_vectors', { points: pointIds }).catch((err) => req.log.warn({ err }, 'qdrant bulk delete failed (non-fatal)'))
        }
        if (deletedRows.length > 0) {
          void sendBrowserPushNotification({
            type: 'memoryRemoved',
            teamId: id.teamId!,
            userId: id.userId,
            title: 'Memories removed',
            body: `${deletedRows.length.toLocaleString()} memor${deletedRows.length === 1 ? 'y was' : 'ies were'} removed.`,
            url: '/memories',
          }).catch((err) => req.log.warn({ err }, 'browser push bulk memory-removed notification failed'))
        }
        return reply.code(200).send({ deleted: deletedRows.length })
      } catch (err) {
        if (err instanceof Error && err.message === 'bulk_preview_stale') return stale()
        throw err
      }
    },
  )

  // ── DELETE /memories — delete_all_memories (bulk, OWN TEAM ONLY) ────────────
  const BulkDeleteBody = z
    .object({
      project: z.string().min(1).optional(),
      confirm: z.literal(true), // explicit confirmation required
    })
    .strict()

  z4.delete(
    '/memories',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: BulkDeleteBody,
        response: {
          200: z.object({ deleted: z.number() }),
          400: ErrorBody,
          409: z.object({ error: z.literal('primary_graph_bulk_delete_forbidden'), message: z.string(), primaryMemoryIds: z.array(z.string()) }),
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const body = req.body
      const teamId = id.teamId! // guaranteed by requireTeamMember
      // CURRENT-TEAM only (reads are universal, so we MUST scope the delete set
      // explicitly — the findMany would otherwise see all teams). A plain member
      // deletes only their OWN-created rows; a team-admin/super-admin deletes any
      // author in the current team. RLS (team_write + owner_floor) backstops both.
      const canDeleteAny = id.isTeamAdmin || id.isGlobalSuperuser
      const where = {
        teamId,
        ...(body.project ? { project: body.project } : {}),
        ...(canDeleteAny ? {} : { createdById: id.userId }),
      }

      // Collect point ids first, delete rows, then purge.
      const pointRows = await runInTenant<{ id: string; project: string; qdrantPointId: string | null; graphGroupId: string | null; graphEpisodeId: string | null }[]>(
        (tx: Tx) =>
          tx.memory.findMany({
            where,
            select: { id: true, project: true, qdrantPointId: true, graphGroupId: true, graphEpisodeId: true },
          }) as PromiseLike<{ id: string; project: string; qdrantPointId: string | null; graphGroupId: string | null; graphEpisodeId: string | null }[]>,
      )
      const grouped = new Map<string, Array<{ id: string; project: string; qdrantPointId: string | null; graphGroupId: string | null; graphEpisodeId: string | null }>>()
      const deletionPlans = new Map<string, Array<{ groupId: string; episodeId: string }>>()
      for (const row of pointRows) {
        const plan = await runInTenant((tx: Tx) => graphDeletionPlanForSubject(tx, {
          subjectKind: 'memory', subjectId: row.id,
          current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
        }))
        deletionPlans.set(row.id, plan)
        for (const episode of plan) grouped.set(episode.groupId, [...(grouped.get(episode.groupId) ?? []), row])
      }
      const primaryMemoryIds: string[] = []
      for (const [groupId, rows] of grouped) {
        const episodeIds = [...new Set(rows.flatMap((row) => deletionPlans.get(row.id) ?? []).filter((episode) => episode.groupId === groupId).map((episode) => episode.episodeId))]
        const impacts = await graphiti.episodeImpact({ groupId, episodeIds })
        const byEpisode = new Map(impacts.map((impact) => [impact.episode_uuid, impact]))
        for (const row of rows) {
          if ((deletionPlans.get(row.id) ?? []).some((episode) => (byEpisode.get(episode.episodeId)?.primary_fact_count ?? 0) > 0)) primaryMemoryIds.push(row.id)
        }
      }
      if (primaryMemoryIds.length > 0) {
        return reply.code(409).send({
          error: 'primary_graph_bulk_delete_forbidden',
          message: 'Agent bulk deletion cannot remove graph-primary memories. Use the dashboard to review each authorized cascade.',
          primaryMemoryIds,
        })
      }
      const deleted = await runInTenant<{ count: number }>(async (tx: Tx) => {
        for (const row of pointRows) {
          await enqueueGraphRemoval(tx, {
            teamId, project: row.project, subjectKind: 'memory', subjectId: row.id,
            current: row.graphGroupId && row.graphEpisodeId ? { groupId: row.graphGroupId, episodeId: row.graphEpisodeId } : null,
          })
        }
        return tx.memory.deleteMany({ where })
      })
      const pointIds = pointRows.map((r) => r.qdrantPointId).filter((p): p is string => !!p)
      if (pointIds.length > 0) {
        await qdrant
          .delete('memory_vectors', { points: pointIds })
          .catch((err) => req.log.warn({ err }, 'qdrant bulk delete failed (non-fatal)'))
      }
      if (deleted.count > 0) {
        void sendBrowserPushNotification({
          type: 'memoryRemoved',
          teamId,
          userId: id.userId,
          title: 'Memories removed',
          body: `${deleted.count.toLocaleString()} personal memor${deleted.count === 1 ? 'y was' : 'ies were'} removed.`,
          url: '/memories',
        }).catch((err) => req.log.warn({ err }, 'browser push bulk memory-removed notification failed'))
      }
      return reply.code(200).send({ deleted: deleted.count })
    },
  )

  // ── GET /entities — list_entities (distinct names across own ∪ granted) ─────
  const EntitiesQuery = z.object({
    project: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  })

  z4.get(
    '/entities',
    {
      preHandler: [requireTeamMember],
      schema: {
        querystring: EntitiesQuery,
        response: {
          200: z.object({
            entities: z.array(z.object({ name: z.string(), count: z.number() })),
          }),
        },
      },
    },
    async (req, reply) => {
      const q = req.query
      const own = getCtx().teamId
      // Fetch entities + teamId under RLS; flatten + dedupe in app code (Prisma
      // can't DISTINCT array elements cleanly). Own-team names listed first.
      const rows = await runInTenant<{ entities: string[]; teamId: string }[]>(
        (tx: Tx) =>
          tx.memory.findMany({
            where: q.project ? { project: q.project } : {},
            select: { entities: true, teamId: true },
          }) as PromiseLike<{ entities: string[]; teamId: string }[]>,
      )
      const ownCounts = new Map<string, number>()
      const grantedCounts = new Map<string, number>()
      for (const r of rows) {
        const target = r.teamId === own ? ownCounts : grantedCounts
        for (const e of r.entities) target.set(e, (target.get(e) ?? 0) + 1)
      }
      const ownNames = [...ownCounts.entries()].map(([name, count]) => ({ name, count }))
      const grantedNames = [...grantedCounts.entries()]
        .filter(([name]) => !ownCounts.has(name))
        .map(([name, count]) => ({ name, count }))
      const entities = [...ownNames, ...grantedNames].slice(0, q.limit)
      return reply.code(200).send({ entities })
    },
  )
}

// ── Shared row helpers ──────────────────────────────────────────────────────

/** The Memory columns selected for list/read responses (incl. teamId + author).
 *  qdrantPointId is carried so PATCH can purge a stale client-managed point on edit. */
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
  memoryTier: true,
  sourceProvenance: true,
  confidence: true,
  qdrantPointId: true,
  createdAt: true,
  recordUpdatedAt: true,
  updatedAt: true,
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
  memoryTier: string
  sourceProvenance: string
  confidence: number
  qdrantPointId: string | null
  createdAt: Date
  recordUpdatedAt: Date
  updatedAt: Date
}

/** Project one Memory row → the wire ResultRow shape, tagging own-vs-other team. */
function toResultRow(r: MemRow): z.infer<typeof ResultRow> {
  return {
    revision: r.revision, classification: r.knowledge, classificationStatus: r.knowledge ? 'classified' : 'legacy_unclassified', embeddingStatus: r.embeddingStatus, graphStatus: r.knowledge ? r.graphStatus : 'legacy_preserved',
    id: r.id,
    content: r.content,
    category: r.category,
    shape: r.shape,
    entities: r.entities,
    project: r.project,
    sessionId: r.sessionId,
    createdById: r.createdById,
    sourceTeam: r.teamId,
    isOwnTeam: r.teamId === getCtx().teamId,
    createdAt: r.createdAt.toISOString(),
    recordUpdatedAt: r.recordUpdatedAt.toISOString(),
    memoryTier: r.memoryTier,
    sourceProvenance: r.sourceProvenance,
    confidence: r.confidence,
  }
}

/** Project many Memory rows → the wire ResultRow shape. */
function toResultRows(rows: MemRow[]): Array<z.infer<typeof ResultRow>> {
  return rows.map(toResultRow)
}

/** Drop undefined-valued keys so the stored metadata JSON stays clean. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

// Keep SearchHit imported usage explicit (merge service types it); satisfies
// verbatimModuleSyntax without an unused-import error if the projection changes.
export type { SearchHit }
