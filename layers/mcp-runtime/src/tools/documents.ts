/**
 * Document tools (map 1:1 to /documents/*, /ingest):
 *   search_documents, get_document, ingest_document, get_ingest_status.
 *
 *   • ingest_document reads a LOCAL file path and streams it as the multipart
 *     `file` part (project nudge enforced; project/title/sessionId as fields).
 *     Note: in BOTH modes the upload sends NO vector — the worker extracts/chunks
 *     server-side and (client-managed embeddings) chunks land pending-embedding, backfilled by the
 *     bridge on reconnect. Only add_memory + searches bridge-embed.
 *   • search_documents embeds the QUERY locally in client-managed embeddings (chunk vectors).
 *   • get_document returns a presigned originalUrl — surfaced to the agent but
 *     NEVER logged (it embeds the MinIO root-cred signature).
 */
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { ApiError } from '../errors.ts'
import { bridgeEmbed } from '../bridge.ts'
import {
  ProjectField,
  SessionId,
  ok,
  toolError,
  fromApiError,
  projectNudge,
  RO_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from '../schemas.ts'
import type { RegisterFn } from './context.ts'

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

export const registerDocumentTools: RegisterFn = (server, { api, runtime }) => {
  // ── ingest_document (multipart upload) ────────────────────────────────────────
  server.registerTool(
    'ingest_document',
    {
      title: 'Ingest a local document',
      description:
        'Upload a local document (pdf/docx/txt/md) into the team memory. Streams the file to storage, ' +
        'then ASYNC-extracts entities/claims/dates/relationships into the graph + vector index (poll ' +
        'get_ingest_status). `project` is REQUIRED (name the repo/project, or "general"). 413 if over ' +
        'the size cap; read-role token → 403.',
      inputSchema: {
        filePath: z
          .string()
          .min(1)
          .describe('Absolute path to the local file to ingest. e.g. "/Users/me/specs/auth.pdf"'),
        project: ProjectField,
        title: z.string().optional().describe('Display title; defaults to the filename. e.g. "Auth spec v2"'),
        sessionId: SessionId,
      },
      outputSchema: {
        jobId: z.string(),
        sourceId: z.string(),
        documentId: z.string(),
        status: z.literal('queued'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      if (!input.project?.trim()) return projectNudge('ingest_document')
      let bytes: Buffer
      try {
        bytes = await readFile(input.filePath)
      } catch (e) {
        return toolError(
          `Cannot read the file at "${input.filePath}" (${e instanceof Error ? e.message : String(e)}). ` +
            'Pass an absolute path to a readable local file.',
        )
      }
      const filename = basename(input.filePath)
      const form = new FormData()
      // The API multipart reader expects the file part named "file" + string fields.
      form.append('file', new Blob([new Uint8Array(bytes)]), filename)
      form.append('project', input.project)
      if (input.title) form.append('title', input.title)
      if (input.sessionId) form.append('sessionId', input.sessionId)
      try {
        const res = await api.postForm<{
          jobId: string
          sourceId: string
          documentId: string
          status: 'queued'
        }>('/ingest', form)
        return ok(
          `Queued ingestion job ${res.jobId} for "${filename}" (document ${res.documentId}). ` +
            'Poll get_ingest_status until completed.',
          res as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_ingest_status ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_ingest_status',
    {
      title: 'Poll an ingestion job',
      description:
        'Poll an ingestion job\'s status (queued → extracting → embedding → completed | failed). On ' +
        'failed, `error` carries the reason. An unreadable/absent job → not_found.',
      inputSchema: { jobId: z.string().uuid().describe('Job id from ingest_document. e.g. "…"') },
      outputSchema: {
        id: z.string(),
        status: z.enum(['queued', 'extracting', 'embedding', 'completed', 'failed']),
        project: z.string(),
        sourceId: z.string().nullable(),
        attempts: z.number(),
        error: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const res = await api.get<Record<string, unknown>>(`/ingest/${input.jobId}`)
        return ok(`Job ${input.jobId}: status=${String(res.status)}.`, res)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── search_documents (semantic over chunks) ───────────────────────────────────
  server.registerTool(
    'search_documents',
    {
      title: 'Search document chunks',
      description:
        'Semantic search over ingested-document chunks (own-first). Returns matching chunks with their ' +
        'documentId — follow with get_document for the original-file link. The input is always ' +
        'natural-language text; server-managed/client-managed embeddings vector handling is internal to the MCP.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Natural-language search over ingested document chunks. e.g. "token rotation policy"'),
        project: z.string().min(1).optional().describe('Restrict to one project.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max chunks. e.g. 20'),
      },
      outputSchema: {
        results: z.array(ChunkHit),
        counts: z.object({ own: z.number(), other: z.number() }),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      const body: Record<string, unknown> = { limit: input.limit }
      if (input.project) body.project = input.project
      if (runtime.mode === 'client-bridge') {
        const r = await bridgeEmbed(runtime, input.query, 'query')
        if (!r.ok) return toolError(r.error)
        if (!r.vector) return toolError('Local embedding produced no vector for the query (client-managed embeddings).')
        body.queryVector = r.vector
      } else {
        body.query = input.query
      }
      try {
        const res = await api.post<{ results: unknown[]; counts: { own: number; other: number } }>(
          '/documents/search',
          body,
        )
        return ok(
          `${res.results.length} chunk(s) (own=${res.counts.own}, other=${res.counts.other}).`,
          res as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_document (metadata + presigned URL) ───────────────────────────────────
  server.registerTool(
    'get_document',
    {
      title: 'Get a document',
      description:
        'Fetch document metadata + a short-lived presigned download URL for the original file (minted ' +
        'only after the read passes RLS; it EXPIRES — do not cache the URL). An unreadable/absent id → ' +
        'not_found.',
      inputSchema: {
        id: z.string().uuid().describe('Document id (from search_documents.documentId). e.g. "…"'),
      },
      outputSchema: {
        id: z.string(),
        title: z.string().nullable(),
        filename: z.string().nullable(),
        versionNumber: z.number(),
        mimeType: z.string().nullable(),
        project: z.string(),
        sourceTeam: z.string(),
        isOwnTeam: z.boolean(),
        originalUrl: z.string().nullable(),
        originalUrlExpiresAt: z.string().nullable(),
        createdAt: z.string(),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const res = await api.get<Record<string, unknown>>(`/documents/${input.id}`)
        // NOTE: res.originalUrl is a secret presigned URL — returned to the agent
        // but NEVER logged (the api-client logs only method+path+status).
        return ok(
          `Document ${input.id} (title=${String(res.title)}, project=${String(res.project)}).`,
          res,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── delete_document (4-store cleanup) ─────────────────────────────────────────
  server.registerTool(
    'delete_document',
    {
      title: 'Delete a document',
      description:
        'Permanently delete a document and ALL of its data — Postgres rows (document + chunks), the ' +
        'vector-index points, the stored original + extracted artifacts, and its graph episode. ' +
        'OWN-TEAM ONLY (cross-team or absent → not_found; RLS is the backstop). Irreversible. To replace ' +
        'a document\'s content, just re-ingest it (same project + filename) — that versions it in place; ' +
        'use delete only to remove it entirely.',
      inputSchema: {
        id: z.string().uuid().describe('Document id to delete (from search_documents.documentId).'),
      },
      outputSchema: {
        deleted: z.literal(true),
        id: z.string(),
        chunkPoints: z.number(),
        blobs: z.number(),
        graphDeleted: z.number(),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (input) => {
      try {
        const res = await api.del<{ deleted: true; id: string; chunkPoints: number; blobs: number; graphDeleted: number }>(
          `/documents/${input.id}`,
        )
        return ok(
          `Deleted document ${input.id} (${res.chunkPoints} vector point(s), ${res.blobs} blob(s), ` +
            `${res.graphDeleted} graph episode(s) removed).`,
          res as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )
}
