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
import { upsertVectors, assertActivePin, type SearchHit } from '@pm/shared'
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

  // ── POST /memories — add_memory ──────────────────────────────────────────
  const AddBody = z
    .object({
      content: z.string().min(40),
      project: z.string().min(1).default('general'),
      sessionId: z.string().optional(),
      metadata: Metadata,
      // client-managed embeddings only (precomputed memory vector from the bridge):
      queryVector: z.array(z.number()).optional(),
      embeddingModelId: z.string().optional(),
      embeddingDim: z.number().int().positive().optional(),
    })
    .strict()

  z4.post(
    '/memories',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: AddBody,
        response: {
          201: z.object({
            id: z.string(),
            shape: z.string(),
            category: z.string(),
            project: z.string(),
            restructured: z.boolean(),
            content: z.string(),
            embeddingStatus: z.enum(['pending', 'embedded']),
            // Phase 9: the agent sees the server-assigned provenance/confidence so it
            // can decide whether to gather more evidence (low confidence = provisional).
            memoryTier: z.string(),
            sourceProvenance: z.string(),
            confidence: z.number(),
          }),
          400: ErrorBody,
          422: z.any(),
          409: ErrorBody,
          500: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const teamId = id.teamId! // guaranteed by requireTeamMember
      const body = req.body
      // `general` is a Personal-only regular-chat partition. Validate before
      // creating any vector or database row on a Shared stack.
      graphProjectGroup(teamId, body.project)
      const meta = body.metadata as WriteMetadata

      // 1. Shape gate. On reject the 422 ValidationError propagates to the handler.
      const verdict = await validateAndRoute(body.content, meta)
      const finalContent = verdict.content
      const shape: MemoryShape = verdict.shape
      const restructured = verdict.outcome === 'restructure'

      // 2. Topology-aware embedding (vector present? → embedded; else → pending).
      let vector: number[] | null = null
      let embeddingStatus: 'pending' | 'embedded' = 'pending'
      if (embedder) {
        const serverEmbedder = embedder
        // server-managed embeddings: the server embeds the (final) content.
        const out = await withEmbeddingHealth(
          { observerScope: 'server', provider: serverEmbedder.provider, model: serverEmbedder.model },
          () => serverEmbedder.embed([finalContent], 'document'),
        )
        vector = out.vectors[0] ?? null
        embeddingStatus = vector ? 'embedded' : 'pending'
      } else if (body.queryVector && body.embeddingModelId && body.embeddingDim) {
        // client-managed embeddings: bridge-supplied precomputed vector — must match the active pin.
        assertActivePin(
          { modelId: body.embeddingModelId, dim: body.embeddingDim, vector: body.queryVector },
          activePin,
        )
        vector = body.queryVector
        embeddingStatus = 'embedded'
      }
      // else client-managed embeddings with no vector → embeddingStatus stays 'pending' (backfilled).

      // 3. Write the Memory row, team STAMPED from identity (never the body).
      const memoryId = randomUUID()
      const auditMeta = restructured
        ? { ...stripUndefined(meta), original_content: verdict.original }
        : stripUndefined(meta)

      // Phase 9 provenance: provenance is DERIVED from the (enum-validated) source
      // server-side — NOT agent-asserted (memory-injection safety). confidence comes
      // from the LLM verdict, else the provenance baseline. tier may be agent-set.
      const provenance = deriveProvenance(meta.source)
      const confidence = verdict.confidence ?? defaultConfidence(provenance)
      const memoryTier =
        (meta as { tier?: MemoryTierValue }).tier ??
        deriveTier({ category: meta.category, hasSession: !!body.sessionId })

      await runInTenant((tx: Tx) =>
        tx.memory.create({
          data: {
            id: memoryId,
            teamId, // ← SERVER-STAMPED from identity, never from body
            createdById: id.userId, // ← author stamped from the token
            project: body.project,
            content: finalContent,
            category: meta.category!, // free-form String column
            shape, // closed enum A–E
            entities: meta.entities ?? [],
            sessionId: body.sessionId ?? null,
            embeddingModelId: activePin.modelId,
            embeddingDim: activePin.dim,
            embeddingStatus,
            metadata: auditMeta as Prisma.InputJsonValue,
            // Phase 9 — server-stamped provenance/tier/confidence.
            memoryTier,
            sourceProvenance: provenance,
            confidence,
            ...graphSyncPendingPatch(),
          },
        }),
      )

      // 4. Qdrant upsert AFTER the row exists (only when a vector is present).
      if (vector) {
        try {
          const idByRow = await upsertVectors(qdrant, {
            teamId,
            pin: activePin,
            items: [{ rowId: memoryId, sourceKind: 'memory', project: body.project, vector }],
          })
          const pointId = idByRow.get(memoryId)
          if (pointId) {
            await runInTenant((tx: Tx) =>
              tx.memory.update({ where: { id: memoryId }, data: { qdrantPointId: pointId } }),
            )
          }
        } catch (err) {
          // A failed vector upsert leaves the row at embeddingStatus we set; flag
          // it pending so the backfill picks it up rather than losing the row.
          req.log.warn({ err, memoryId }, 'qdrant upsert failed; marking pending')
          await runInTenant((tx: Tx) =>
            tx.memory.update({ where: { id: memoryId }, data: { embeddingStatus: 'pending' } }),
          ).catch(() => {})
          embeddingStatus = 'pending'
        }
      }

      // 5. Best-effort Graphiti episode in this exact surface/team/project partition.
      // Vector bookkeeping advances updatedAt but deliberately leaves the graph
      // content version untouched, so the inline graph stamp cannot race itself.
      const graphVersion = await runInTenant<{ graphVersion: Date } | null>(
        (tx: Tx) => tx.memory.findUnique({ where: { id: memoryId }, select: { graphVersion: true } }) as PromiseLike<{ graphVersion: Date } | null>,
      )
      if (graphVersion) {
        const graphOperationId = randomUUID()
        void postMemoryGraphEpisodeAndStamp(graphiti, {
          id: memoryId,
          teamId,
          project: body.project,
          graphGroupId: graphProjectGroup(teamId, body.project),
          content: finalContent,
          graphVersion: graphVersion.graphVersion,
        }, undefined, { operationId: graphOperationId })
          .catch((err) => req.log.warn({ err, memoryId }, 'graphiti episode failed (non-fatal)'))
        reply.header('x-pm-graph-operation-id', graphOperationId)
      }
      void sendBrowserPushNotification({
        type: 'memoryAdded',
        teamId,
        userId: id.userId,
        title: 'Memory added',
        body: 'A personal memory was added.',
        url: '/memories',
      }).catch((err) => req.log.warn({ err, memoryId }, 'browser push memory-added notification failed'))

      return reply.code(201).send({
        id: memoryId,
        shape,
        category: meta.category!,
        project: body.project,
        restructured,
        content: finalContent,
        embeddingStatus,
        memoryTier,
        sourceProvenance: provenance,
        confidence,
      })
    },
  )

  // ── POST /memories/search — search_memories (the cross-team merge) ─────────
  const SearchBody = z
    .object({
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

      // Embed the query (topology-aware). server-managed embeddings: server embeds. client-managed embeddings: bridge vector.
      let queryVector: number[]
      if (embedder) {
        const serverEmbedder = embedder
        const query = body.query
        if (!query) {
          return reply
            .code(400)
            .send({ error: 'query_required', message: 'query is required in server-managed embeddings (server embedder).' })
        }
        const out = await withEmbeddingHealth(
          { observerScope: 'server', provider: serverEmbedder.provider, model: serverEmbedder.model },
          () => serverEmbedder.embed([query], 'query'),
        )
        const v = out.vectors[0]
        if (!v) {
          return reply
            .code(500)
            .send({ error: 'embed_failed', message: 'query embedding produced no vector.' })
        }
        queryVector = v
      } else {
        if (!body.queryVector) {
          return reply.code(400).send({
            error: 'query_vector_required',
            message: 'client-managed embeddings (client-bridge): a precomputed queryVector is required (the server has no embedder).',
          })
        }
        if (body.queryVector.length !== activePin.dim) {
          return reply.code(422).send({
            error: 'vector_dim_mismatch',
            message: `queryVector dim ${body.queryVector.length} != active dim ${activePin.dim}.`,
          })
        }
        queryVector = body.queryVector
      }

      // Universal (all-teams) reads on the data plane are admin-only. A plain
      // member's `universal:true` is IGNORED → own ∪ mounted (mounts are how a
      // member is granted cross-team reads). The dashboard's all-teams view for
      // members goes through /dashboard/memories (decideDashboard), not this route.
      const universal = allowUniversalRead(id.adminLevel, body.universal)

      const merged = await searchMemoriesMerged(qdrant, {
        queryVector,
        pin: activePin,
        ...(body.project ? { project: body.project } : {}),
        ...(body.category ? { category: body.category } : {}),
        ...(body.scoreMin !== undefined ? { scoreMin: body.scoreMin } : {}),
        ...(body.scoreMax !== undefined ? { scoreMax: body.scoreMax } : {}),
        limit: body.limit,
        ...(universal ? { universal: true } : {}),
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
              entities:
                body.mode === 'all'
                  ? { hasEvery: body.entities }
                  : { hasSome: body.entities },
              ...(body.project ? { project: body.project } : {}),
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
        ...(q.project ? { project: q.project } : {}),
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

  // ── PATCH /memories/:id — update_memory (re-validate; own-team RLS) ─────────
  const PatchBody = z
    .object({
      content: z.string().min(40).optional(),
      project: z.string().min(1).optional(),
      sessionId: z.string().optional(),
      metadata: Metadata.optional(),
    })
    .strict()

  z4.patch(
    '/memories/:id',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: IdParam,
        body: PatchBody,
        response: {
          200: ResultRow.extend({ restructured: z.boolean() }),
          404: z.object({ error: z.string() }),
          422: z.any(),
          409: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const body = req.body

      // findUnique first (universal read) → 404 if absent.
      const existing = await runInTenant<MemRow | null>(
        (tx: Tx) =>
          tx.memory.findUnique({
            where: { id: req.params.id },
            select: MEM_SELECT,
          }) as PromiseLike<MemRow | null>,
      )
      if (!existing) return reply.code(404).send({ error: 'not_found' })

      // Per-row authorization (current-team + ownership). Backstopped by RLS.
      const decision = decideDataPlane({
        identity: id,
        action: 'update',
        target: { teamId: existing.teamId, createdById: existing.createdById },
      })
      if (!decision.ok) throw decision.error
      const teamId = existing.teamId // == id.teamId (decision enforced)

      const route = classifyMemoryUpdate(existing, {
        content: body.content,
        project: body.project,
        sessionId: body.sessionId,
        category: body.metadata?.category,
        entities: body.metadata?.entities,
      })
      if (!route.hasChanges) return reply.code(200).send({ ...toResultRow(existing), restructured: false })

      if (route.projectChanged) graphProjectGroup(teamId, body.project!)

      if (route.projectChanged) {
        const hasGraphHistory = await runInTenant<number>(
          (tx: Tx) => tx.graphEpisodeProvenance.count({ where: { subjectKind: 'memory', subjectId: existing.id } }) as PromiseLike<number>,
        )
        try {
          assertProjectMovePreservesGraphBoundary({
            currentProject: existing.project,
            nextProject: body.project!,
            hasGraphHistory: hasGraphHistory > 0,
          })
        } catch (err) {
          return reply.code(409).send({ error: 'project_graph_history_immutable', message: err instanceof Error ? err.message : String(err) })
        }
      }

      // Re-validate when content or metadata changes.
      let restructured = false
      let nextContent = existing.content
      let nextShape: MemoryShape = existing.shape as MemoryShape
      let nextCategory = existing.category
      let nextEntities = existing.entities
      let auditExtra: Record<string, unknown> = {}

      if (route.validationRequired) {
        const content = body.content ?? existing.content
        const meta: WriteMetadata = body.metadata
          ? (body.metadata as WriteMetadata)
          : { category: existing.category, entities: existing.entities, source: 'gotcha-discovered' }
        const verdict = await validateAndRoute(content, meta)
        nextContent = verdict.content
        nextShape = verdict.shape
        restructured = verdict.outcome === 'restructure'
        if (route.metadataChanged && body.metadata) {
          nextCategory = body.metadata.category
          nextEntities = body.metadata.entities
        }
        if (verdict.outcome === 'restructure') auditExtra = { original_content: verdict.original }
      }

      // server-managed embeddings: re-embed inline. client-managed embeddings: can't embed here — we must NOT leave the
      // old vector searchable for the edited content, so we drop it + mark pending
      // (the P6 backfill re-embeds later, recreating the SAME deterministic point).
      let vector: number[] | null = null
      let embeddingStatus: 'pending' | 'embedded' = 'pending'
      const contentChanged = nextContent !== existing.content
      const graphChanged = contentChanged
      const graphOperationId = graphChanged ? randomUUID() : null
      // client-managed embeddings with a content change → purge the stale point, status pending.
      const dropStaleVectorClientManaged = contentChanged && !embedder
      if (contentChanged && embedder) {
        const serverEmbedder = embedder
        const out = await withEmbeddingHealth(
          { observerScope: 'server', provider: serverEmbedder.provider, model: serverEmbedder.model },
          () => serverEmbedder.embed([nextContent], 'document'),
        )
        vector = out.vectors[0] ?? null
        embeddingStatus = vector ? 'embedded' : 'pending'
      }

      // A project-only move changes Qdrant routing metadata, not vector content.
      // Move the payload first: until Postgres commits, the project hydrate filter
      // rejects the point in both scopes, so the transition can hide briefly but
      // cannot leak across projects. Restore best-effort if the DB write fails.
      let qdrantProjectMoved = false
      if (route.projectChanged && existing.qdrantPointId) {
        await qdrant.setPayload('memory_vectors', {
          wait: true,
          points: [existing.qdrantPointId],
          payload: { project: body.project! },
        })
        qdrantProjectMoved = true
      }

      const nextGraphVersion = contentChanged || route.projectChanged ? new Date() : null

      // Update under RLS (own-team only; WITH CHECK backstops cross-team).
      let updated: MemRow
      try {
        updated = await runInTenant<MemRow>(
          (tx: Tx) =>
            tx.memory.update({
              where: { id: req.params.id },
              data: {
                ...(contentChanged ? { content: nextContent } : {}),
                ...(route.validationRequired ? { shape: nextShape } : {}),
                ...(route.metadataChanged ? { category: nextCategory, entities: nextEntities } : {}),
                ...(route.projectChanged ? { project: body.project! } : {}),
                ...(route.sessionChanged ? { sessionId: body.sessionId } : {}),
                // Only user-visible mutations advance the table's Updated value.
                recordUpdatedAt: new Date(),
                // server-managed embeddings: embedded/pending per the embed result. client-managed embeddings: force pending
                // so search never serves a stale embedding for the edited content.
                ...(contentChanged && embedder ? { embeddingStatus } : {}),
                ...(dropStaleVectorClientManaged ? { embeddingStatus: 'pending' as const } : {}),
                ...(graphChanged ? graphSyncPendingPatch(nextGraphVersion!) : {}),
                ...(!graphChanged && route.projectChanged ? { graphVersion: nextGraphVersion! } : {}),
                ...(Object.keys(auditExtra).length
                  ? { metadata: auditExtra as Prisma.InputJsonValue }
                  : {}),
              },
              select: MEM_SELECT,
            }) as PromiseLike<MemRow>,
        )
      } catch (error) {
        if (qdrantProjectMoved && existing.qdrantPointId) {
          await qdrant.setPayload('memory_vectors', {
            wait: true,
            points: [existing.qdrantPointId],
            payload: { project: existing.project },
          }).catch((restoreError) => req.log.error({ err: restoreError, id: existing.id }, 'qdrant project payload rollback failed'))
        }
        throw error
      }

      // server-managed embeddings: re-upsert onto the SAME deterministic point id (overwrites in place,
      // no orphan — the point id is now derived from the rowId). A failure (embed
      // produced no vector, or upsert threw) leaves the row at 'pending' — and the
      // OLD point still live, hence stale — so we treat that exactly like client-managed embeddings
      // below and drop the existing point.
      let dropStaleVectorServerManagedFail = false
      if (contentChanged && embedder) {
        if (vector) {
          try {
            const idByRow = await upsertVectors(qdrant, {
              teamId,
              pin: activePin,
              items: [
                { rowId: updated.id, sourceKind: 'memory', project: updated.project, vector },
              ],
            })
            const pointId = idByRow.get(updated.id)
            if (pointId) {
              await runInTenant((tx: Tx) =>
                tx.memory.update({ where: { id: updated.id }, data: { qdrantPointId: pointId } }),
              )
            }
          } catch (err) {
            req.log.warn({ err, id: updated.id }, 'qdrant re-upsert failed; marking pending')
            await runInTenant((tx: Tx) =>
              tx.memory.update({ where: { id: updated.id }, data: { embeddingStatus: 'pending' } }),
            ).catch(() => {})
            dropStaleVectorServerManagedFail = true // upsert threw → old point is now stale
          }
        } else {
          // embed() returned no vector → row stayed 'pending'; the old point is stale.
          dropStaleVectorServerManagedFail = true
        }
      }

      // Drop the existing point so the edited content can't be served via its
      // now-stale vector. Fires for client-managed embeddings (no embedder) OR a server-managed embed/upsert
      // failure — both end at 'pending'. The P6 consumer re-embeds the 'pending'
      // row later, recreating the SAME deterministic point id from updated.id.
      if ((dropStaleVectorClientManaged || dropStaleVectorServerManagedFail) && existing.qdrantPointId) {
        await qdrant
          .delete('memory_vectors', { points: [existing.qdrantPointId] })
          .catch((err) =>
            req.log.warn({ err, id: updated.id }, 'qdrant stale-point delete failed (pending edit)'),
          )
      }

      // Best-effort Graphiti re-episode. graphiti-core 0.29.2 does not support
      // create-with-uuid/upsert semantics; sending a new uuid makes the graph
      // write fail with NodeNotFoundError.
      if (graphChanged) {
        const graphVersion = await runInTenant<{ graphVersion: Date } | null>(
          (tx: Tx) => tx.memory.findUnique({ where: { id: updated.id }, select: { graphVersion: true } }) as PromiseLike<{ graphVersion: Date } | null>,
        )
        if (graphVersion) {
          void postMemoryGraphEpisodeAndStamp(graphiti, {
            id: updated.id,
            teamId,
            project: updated.project,
            graphGroupId: graphProjectGroup(teamId, updated.project),
            content: updated.content,
            graphVersion: graphVersion.graphVersion,
          }, undefined, { operationId: graphOperationId! })
            .catch((err) => req.log.warn({ err, id: updated.id }, 'graphiti re-episode failed'))
        }
      }
      if (graphOperationId) reply.header('x-pm-graph-operation-id', graphOperationId)
      void sendBrowserPushNotification({
        type: 'memoryUpdated',
        teamId,
        userId: id.userId,
        title: 'Memory updated',
        body: 'A personal memory was updated.',
        url: '/memories',
      }).catch((err) => req.log.warn({ err, id: updated.id }, 'browser push memory-updated notification failed'))

      return reply.code(200).send({ ...toResultRow(updated), restructured })
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
