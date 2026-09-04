/**
 * persistent-memory-api — document endpoints. Map to the MCP tools
 * search_documents / get_document. All require team membership.
 *
 *   • POST /documents/search — embed query (server-managed embeddings) or require client queryVector
 *     (client-managed embeddings, validated == activePin.dim), searchVectors(sourceKind='chunk',
 *     allTeams — reads are universal), then RE-READ each hit Chunk row through
 *     runInTenant (RLS universal_read) — drop any hit whose Postgres row is
 *     unreadable. RLS is the net. Own-first ordering.
 *   • GET /documents/:id — runInTenant findUnique (unreadable/absent → 404), then
 *     mint a presigned MinIO URL AFTER the RLS read returns non-null. TTL =
 *     DOC_URL_EXPIRY_SECONDS (clamped to the 604800s S3 cap). The URL is never
 *     logged (it embeds the MinIO root-cred signature; MinIO has no per-team
 *     bucket policy, so the presigned URL is the ONLY path to the blob).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { searchVectors, presignedGetUrl, removePrefix, sourcePrefix, deleteChunkPointsForDocument } from '@pm/shared'
import { runInTenant, getCtx, type Tx } from '@pm/db'
import { requireTeamMember } from '../authz/guards.ts'
import { embedder, qdrant, activePin } from '../services/embedding.ts'
import { withEmbeddingHealth } from '../services/embedding-health.ts'
import { minio } from '../services/storage.ts'
import { config } from '../config.ts'
import { enqueueGraphRemoval } from '../services/graph-lifecycle.ts'

const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })

const ChunkHit = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  ordinal: z.number(),
  content: z.string(),
  project: z.string(),
  score: z.number(),
  sourceTeam: z.string(),
  isOwnTeam: z.boolean(),
})

type ChunkRow = {
  id: string
  teamId: string
  documentId: string
  ordinal: number
  content: string
  project: string
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── POST /documents/search — search_documents ──────────────────────────────
  const SearchBody = z
    .object({
      query: z.string().min(1).optional(),
      queryVector: z.array(z.number()).optional(), // client-managed embeddings
      project: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict()
    .refine((b) => b.query || b.queryVector, {
      message: 'query (server-managed embeddings) or queryVector (client-managed embeddings) is required',
    })

  z4.post(
    '/documents/search',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: SearchBody,
        response: {
          200: z.object({
            results: z.array(ChunkHit),
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
      const ctx = getCtx()
      const own = ctx.teamId

      // Topology-aware query vector.
      let queryVector: number[]
      if (embedder) {
        const serverEmbedder = embedder
        const query = body.query
        if (!query) {
          return reply
            .code(400)
            .send({ error: 'query_required', message: 'query is required in server-managed embeddings.' })
        }
        const out = await withEmbeddingHealth(
          { observerScope: 'server', provider: serverEmbedder.provider, model: serverEmbedder.model },
          () => serverEmbedder.embed([query], 'query'),
        )
        const v = out.vectors[0]
        if (!v) return reply.code(500).send({ error: 'embed_failed' })
        queryVector = v
      } else {
        if (!body.queryVector) {
          return reply.code(400).send({
            error: 'query_vector_required',
            message: 'client-managed embeddings: a precomputed queryVector is required (server has no embedder).',
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

      // Qdrant fan-out: team_id ∈ readableTeams AND source_kind='chunk'.
      const hits = await searchVectors(qdrant, {
        queryVector,
        pin: activePin,
        allTeams: true,
        ...(body.project ? { project: body.project } : {}),
        sourceKind: 'chunk',
        limit: body.limit,
      })
      if (hits.length === 0) {
        return reply.code(200).send({ results: [], counts: { own: 0, other: 0 } })
      }

      // RLS re-read: drop any hit whose Chunk row is unreadable (RLS wins).
      const rowIds = hits.map((h) => h.rowId).filter((id) => id.length > 0)
      const rows = await runInTenant<ChunkRow[]>(
        (tx: Tx) =>
          tx.chunk.findMany({
            where: { id: { in: rowIds } },
            select: {
              id: true,
              teamId: true,
              documentId: true,
              ordinal: true,
              content: true,
              project: true,
            },
          }) as PromiseLike<ChunkRow[]>,
      )
      const byId = new Map(rows.map((r) => [r.id, r]))

      const merged = hits
        .map((h) => {
          const r = byId.get(h.rowId)
          if (!r) return null // RLS dropped → discard hit
          return {
            chunkId: r.id,
            documentId: r.documentId,
            ordinal: r.ordinal,
            content: r.content,
            project: r.project,
            score: h.score,
            sourceTeam: r.teamId,
            isOwnTeam: r.teamId === own,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)

      const ownHits = merged.filter((m) => m.isOwnTeam).sort((a, b) => b.score - a.score)
      const otherHits = merged.filter((m) => !m.isOwnTeam).sort((a, b) => b.score - a.score)
      return reply.code(200).send({
        results: [...ownHits, ...otherHits],
        counts: { own: ownHits.length, other: otherHits.length },
      })
    },
  )

  // ── GET /documents/:id — get_document (RLS → 404; presigned URL after read) ──
  z4.get(
    '/documents/:id',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            title: z.string().nullable(),
            filename: z.string().nullable(),
            versionNumber: z.number().int(),
            mimeType: z.string().nullable(),
            project: z.string(),
            sourceTeam: z.string(),
            isOwnTeam: z.boolean(),
            originalUrl: z.string().nullable(),
            originalUrlExpiresAt: z.string().nullable(),
            createdAt: z.string(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      type Row = {
        id: string
        teamId: string
        title: string | null
        filename: string | null
        versionNumber: number
        mimeType: string | null
        project: string
        minioObjectKey: string | null
        createdAt: Date
      }
      const doc = await runInTenant<Row | null>(
        (tx: Tx) =>
          tx.document.findUnique({
            where: { id: req.params.id },
            select: {
              id: true,
              teamId: true,
              title: true,
              filename: true,
              versionNumber: true,
              mimeType: true,
              project: true,
              minioObjectKey: true,
              createdAt: true,
            },
          }) as PromiseLike<Row | null>,
      )
      // RLS fail-closed → 404 (indistinguishable from "doesn't exist").
      if (!doc) return reply.code(404).send({ error: 'not_found' })

      // Mint the presigned URL ONLY after the RLS read returned non-null.
      const ttl = Math.min(config.DOC_URL_EXPIRY_SECONDS, 604_800)
      let originalUrl: string | null = null
      let originalUrlExpiresAt: string | null = null
      if (doc.minioObjectKey) {
        originalUrl = await presignedGetUrl(minio, doc.minioObjectKey, ttl)
        originalUrlExpiresAt = new Date(Date.now() + ttl * 1000).toISOString()
      }

      return reply.code(200).send({
        id: doc.id,
        title: doc.title,
        filename: doc.filename,
        versionNumber: doc.versionNumber,
        mimeType: doc.mimeType,
        project: doc.project,
        sourceTeam: doc.teamId,
        isOwnTeam: doc.teamId === getCtx().teamId,
        originalUrl, // NEVER logged — embeds the MinIO root-cred signature
        originalUrlExpiresAt,
        createdAt: doc.createdAt.toISOString(),
      })
    },
  )

  // ── DELETE /documents/:id — guarded 4-store cleanup (Phase 11, #6) ───────────
  // Deletes the document's SOURCE, so Postgres cascades Document→Chunk (and Claim/
  // Entity) and SetNulls any derived Memory.sourceId — the plan's
  // "cascade Source→Document→Chunk, derived memories SetNull" in one DB op. Then the
  // OTHER three stores are cleaned best-effort: Qdrant chunk points, the MinIO blob +
  // artifacts (the source prefix), and the Graphiti episode. Own-team only (documents
  // are universally READABLE but team-bound for writes); a plain team member may delete
  // (symmetric with upload — documents are shared team assets, no per-user owner). RLS
  // is the backstop (a cross-team delete matches 0 rows → 404).
  z4.delete(
    '/documents/:id',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            deleted: z.literal(true),
            id: z.string(),
            chunkPoints: z.number(),
            blobs: z.number(),
            graphDeleted: z.number(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const own = getCtx().teamId
      const doc = await runInTenant<{ teamId: string; sourceId: string; project: string; graphGroupId: string | null; graphEpisodeId: string | null } | null>(
        (tx: Tx) =>
          tx.document.findUnique({
            where: { id: req.params.id },
            select: { teamId: true, sourceId: true, project: true, graphGroupId: true, graphEpisodeId: true },
          }) as PromiseLike<{ teamId: string; sourceId: string; project: string; graphGroupId: string | null; graphEpisodeId: string | null } | null>,
      )
      // Universal read can return another team's doc — fail closed on a cross-team
      // delete (don't reveal it's deletable; RLS also blocks the write below).
      if (!doc || doc.teamId !== own) return reply.code(404).send({ error: 'not_found' })

      // Chunk count BEFORE the cascade deletes the rows (response observability only —
      // the actual Qdrant cleanup is a payload filter-delete below, not by these ids).
      const chunkCount = await runInTenant<number>(
        (tx: Tx) => tx.chunk.count({ where: { document: { sourceId: doc.sourceId } } }) as PromiseLike<number>,
      )

      // Postgres: delete the Source → cascades Document + Chunk (+ Claim/Entity),
      // SetNulls Memory.sourceId. deleteMany so an RLS miss → 0 rows → 404.
      const del = await runInTenant<{ count: number }>(async (tx: Tx) => {
        await enqueueGraphRemoval(tx, {
          teamId: doc.teamId,
          project: doc.project,
          subjectKind: 'document',
          subjectId: req.params.id,
          current: doc.graphGroupId && doc.graphEpisodeId ? { groupId: doc.graphGroupId, episodeId: doc.graphEpisodeId } : null,
        })
        return tx.source.deleteMany({ where: { id: doc.sourceId } })
      })
      if (del.count === 0) return reply.code(404).send({ error: 'not_found' })

      // Qdrant chunk points (best-effort) — FILTER-delete by document_id (drops ALL of
      // the doc's points, INCLUDING any orphans from an earlier interrupted re-ingest),
      // not the per-row ids (which would miss those orphans).
      await deleteChunkPointsForDocument(qdrant, req.params.id).catch((err) =>
        req.log.warn({ err }, 'qdrant chunk delete failed (non-fatal)'),
      )
      // MinIO original + artifacts under the source prefix (best-effort).
      let blobs = 0
      await removePrefix(minio, sourcePrefix({ teamId: own, project: doc.project, sourceId: doc.sourceId }))
        .then((n) => (blobs = n))
        .catch((err) => req.log.warn({ err }, 'minio prefix delete failed (non-fatal)'))
      // Graphiti deletion is a durable lifecycle command; the worker reports its
      // completion only after the removed episode no longer appears in impact.
      return reply.code(200).send({ deleted: true, id: req.params.id, chunkPoints: chunkCount, blobs, graphDeleted: 0 })
    },
  )
}
