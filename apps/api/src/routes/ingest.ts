/**
 * persistent-memory-api — the real ingest endpoints (Phase 6; replaces the P3/P5
 * demo routes).
 *
 *   • POST /ingest        — multipart file upload. requireWrite gates team_role;
 *     the file streams straight to MinIO (no buffering) under a server-derived
 *     key, THEN Source + Document + IngestJob(queued) are created in ONE
 *     runInTenant (team STAMPED from identity.teamId — never the body), THEN a
 *     BullMQ job is enqueued with the team from identity. Returns { jobId }.
 *   • GET /ingest/:jobId  — status, RLS-scoped (a job in an unreadable team →
 *     findUnique returns null → 404; no cross-team existence leak).
 *
 * Order discipline (gotchas): MinIO put happens BEFORE the row writes so a failed
 * upload leaves no orphan rows; the enqueue happens AFTER the rows commit so the
 * worker never races a missing IngestJob row. project/title/sessionId are
 * best-effort multipart fields (default project "general"); team is ALWAYS
 * identity.teamId. RLS WITH CHECK (team_id = pm_current_team_id()) backstops the
 * server-side stamp.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { MultipartFile } from '@fastify/multipart'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import {
  originalKey,
  putStream,
  removeObject,
  enqueueIngest,
  type IngestJobData,
} from '@pm/shared'
import { runInTenant, Prisma } from '@pm/db'
import { requireTeamMember } from '../authz/guards.ts'
import { minio } from '../services/storage.ts'
import { ingestQueue } from '../services/queue.ts'
import { config } from '../config.ts'

/** Shared error-body shape for the ingest endpoints. */
const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })

// @fastify/multipart augments Fastify via `declare module 'fastify'`, but in this
// nested-node_modules workspace the augmentation does not reliably reach the api's
// fastify copy. So we access the two multipart capabilities through explicit typed
// views instead of relying on the global merge.
type WithFile = { file: () => Promise<MultipartFile | undefined> }
type WithMultipartErrors = {
  multipartErrors: { RequestFileTooLargeError: new (...args: never[]) => Error }
}

/** Read a best-effort string value from the multipart fields map. */
function fieldValue(
  fields: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const f = fields?.[name] as { value?: unknown } | undefined
  const v = f?.value
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── POST /ingest — multipart upload → MinIO → rows → enqueue. ──────────────
  z4.post(
    '/ingest',
    {
      preHandler: [requireTeamMember],
      schema: {
        response: {
          201: z.object({
            jobId: z.string(),
            sourceId: z.string(),
            documentId: z.string(),
            status: z.literal('queued'),
          }),
          400: ErrorBody,
          409: ErrorBody,
          413: ErrorBody,
          500: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const teamId = id.teamId! // guaranteed by requireTeamMember
      // stream-only (attachFieldsToBody is off). Typed view — see WithFile note.
      const data = await (req as FastifyRequest & WithFile).file()
      if (!data) {
        return reply
          .code(400)
          .send({ error: 'no_file', message: 'multipart file part "file" is required.' })
      }

      const project = fieldValue(data.fields, 'project') ?? 'general'
      const title = fieldValue(data.fields, 'title') ?? data.filename
      const sessionId = fieldValue(data.fields, 'sessionId') ?? null

      // P11 dedup: a re-upload of the same (project, filename) is the SAME logical
      // document — reuse its id + source + object key so the worker compares content
      // hashes and either skips (unchanged) or versions in place (changed). Keyed by
      // filename, not the user-overridable title. ponytail: plain index + findFirst
      // (most-recent); a rare concurrent first-upload of an identical new filename
      // could create two logical docs — add @@unique + P2002 handling if it matters.
      const existing = await runInTenant<{ id: string; sourceId: string; minioObjectKey: string | null } | null>(
        (tx) =>
          tx.document.findFirst({
            where: { teamId, project, filename: data.filename },
            orderBy: { createdAt: 'desc' },
            select: { id: true, sourceId: true, minioObjectKey: true },
          }) as PromiseLike<{ id: string; sourceId: string; minioObjectKey: string | null } | null>,
      )

      // Reuse the prior source/key on a re-upload; mint fresh on a first upload.
      const sourceId = existing?.sourceId ?? randomUUID()
      const key = existing?.minioObjectKey ?? originalKey({ teamId, project, sourceId, filename: data.filename })

      // Stream the original to MinIO FIRST (size omitted → unknown-length multipart).
      // On a re-upload this OVERWRITES the prior blob at the same key.
      try {
        await putStream(minio, key, data.file, data.mimetype)
      } catch (err) {
        const mpErrors = (app as FastifyInstance & WithMultipartErrors).multipartErrors
        if (err instanceof mpErrors.RequestFileTooLargeError) {
          return reply.code(413).send({
            error: 'file_too_large',
            message: `File exceeds the ${config.INGEST_MAX_FILE_BYTES}-byte ingest limit.`,
          })
        }
        req.log.error({ err }, 'minio putObject failed')
        return reply
          .code(500)
          .send({ error: 'storage_error', message: 'Failed to store the uploaded file.' })
      }
      // A fileSize-limit truncation leaves a partial blob — clean it up + 413.
      // (On a re-upload the partial already overwrote the prior blob at this key;
      // the prior content is unrecoverable either way. ponytail: a temp-key +
      // copy-on-success would protect it — not worth it for an over-limit re-upload.)
      if (data.file.truncated) {
        if (!existing) await removeObject(minio, key).catch(() => {})
        return reply.code(413).send({
          error: 'file_too_large',
          message: `File exceeds the ${config.INGEST_MAX_FILE_BYTES}-byte ingest limit.`,
        })
      }

      // Canonical rows + job, team STAMPED server-side, in ONE tx. On a re-upload we
      // REUSE the prior Document/Source (so the worker hash-compares + versions in
      // place) and only update the title + enqueue a fresh job; a first upload creates
      // the full Source + Document(filename) + IngestJob triple.
      let jobId: string
      let documentId: string
      try {
        ;({ jobId, documentId } = await runInTenant<{ jobId: string; documentId: string }>(
        async (tx) => {
          let docId: string
          if (existing) {
            // Re-upload: keep the prior Document/Source (worker hash-compares),
            // apply a title-only change in place (@updatedAt touches the row).
            await tx.document.update({ where: { id: existing.id }, data: { title } })
            docId = existing.id
          } else {
            await tx.source.create({
              data: {
                id: sourceId,
                teamId, // ← SERVER-STAMPED from identity, never from body
                project,
                kind: 'document',
                title: data.filename,
                minioObjectKey: key,
                sessionId,
              },
            })
            const document = await tx.document.create({
              data: {
                teamId,
                project,
                sourceId,
                title,
                filename: data.filename, // P11 dedup identity (raw filename)
                mimeType: data.mimetype,
                minioObjectKey: key,
              },
              select: { id: true },
            })
            docId = document.id
          }
          const job = await tx.ingestJob.create({
            data: { teamId, project, sourceId, status: 'queued', sessionId },
            select: { id: true },
          })
          return { jobId: job.id, documentId: docId }
        },
        ))
      } catch (err) {
        // The @@unique(teamId, project, filename) rejects a CONCURRENT first-upload of
        // the same filename (the dedup findFirst above raced another request that
        // hadn't committed yet). The DB guarantees no duplicate logical doc; the loser
        // cleans its just-streamed blob (its own fresh sourceId key — never the prior
        // doc's) and gets a 409 to retry, which then takes the dedup/re-upload path.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          if (!existing) await removeObject(minio, key).catch(() => {})
          return reply.code(409).send({
            error: 'upload_conflict',
            message:
              `A concurrent upload of "${data.filename}" to project "${project}" is in progress. ` +
              'Retry — it will update that document instead of creating a duplicate.',
          })
        }
        throw err
      }

      // Enqueue AFTER the commit. teamId comes from identity, never the body.
      const payload: IngestJobData = {
        ingestJobId: jobId,
        sourceId,
        documentId,
        teamId,
        project,
        minioObjectKey: key,
        mimeType: data.mimetype,
        filename: data.filename,
        sessionId,
      }
      let bullJobId: string
      try {
        bullJobId = await enqueueIngest(ingestQueue, payload)
      } catch (err) {
        // The blob + rows committed but the queue is unreachable. Stamp the row
        // failed/enqueue_failed so it surfaces (a silent `queued` orphan would look
        // pending forever) and return an error. The ingest-reconciler covers the
        // OTHER failure mode — a crash BETWEEN the commit and this enqueue, where
        // this catch never runs and the row is left recoverably `queued`.
        req.log.error({ err }, 'ingest enqueue failed')
        await runInTenant((tx) =>
          tx.ingestJob.update({
            where: { id: jobId },
            data: { status: 'failed', error: 'enqueue_failed' },
          }),
        ).catch((e) => req.log.error({ err: e }, 'enqueue_failed stamp also failed'))
        return reply.code(500).send({
          error: 'enqueue_failed',
          message: 'The file was stored but could not be queued for processing. Please retry.',
        })
      }
      // Correlate the Bull job id back (best-effort; jobId === ingestJobId anyway).
      await runInTenant((tx) =>
        tx.ingestJob.update({ where: { id: jobId }, data: { bullJobId } }),
      ).catch((err) => req.log.warn({ err }, 'ingestJob.bullJobId update failed (non-fatal)'))

      return reply.code(201).send({ jobId, sourceId, documentId, status: 'queued' })
    },
  )

  // ── GET /ingest/:jobId — status, RLS-scoped (unreadable → 404). ────────────
  z4.get(
    '/ingest/:jobId',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: z.object({ jobId: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            status: z.enum(['queued', 'extracting', 'embedding', 'completed', 'failed']),
            // Graphiti episode outcome, tracked independently of `status` (step 6 is
            // best-effort). Surfaced so operators/agents can detect the "in Qdrant but
            // not the graph" partial state — a `completed` job with graphStatus=failed.
            graphStatus: z.enum(['pending', 'ok', 'failed', 'skipped']),
            project: z.string(),
            sourceId: z.string().nullable(),
            attempts: z.number(),
            error: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      type Row = {
        id: string
        status: 'queued' | 'extracting' | 'embedding' | 'completed' | 'failed'
        graphStatus: 'pending' | 'ok' | 'failed' | 'skipped'
        project: string
        sourceId: string | null
        attempts: number
        error: string | null
        createdAt: Date
        updatedAt: Date
      }
      const job = await runInTenant<Row | null>(
        (tx) =>
          tx.ingestJob.findUnique({
            where: { id: req.params.jobId },
            select: {
              id: true,
              status: true,
              graphStatus: true,
              project: true,
              sourceId: true,
              attempts: true,
              error: true,
              createdAt: true,
              updatedAt: true,
            },
          }) as PromiseLike<Row | null>,
      )
      // RLS scopes to own ∪ granted; an unreadable job returns null → 404
      // (fail-closed, indistinguishable from "doesn't exist").
      if (!job) return reply.code(404).send({ error: 'not_found' })
      return reply.code(200).send({
        id: job.id,
        status: job.status,
        graphStatus: job.graphStatus,
        project: job.project,
        sourceId: job.sourceId,
        attempts: job.attempts,
        error: job.error,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      })
    },
  )
}
