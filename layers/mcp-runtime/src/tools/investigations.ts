/**
 * Investigation tools (map 1:1 to /investigations*):
 *   create_investigation, get_investigation, link_investigation.
 *
 * create_investigation enforces the project nudge. link_investigation is
 * idempotent (re-linking the same target returns the existing link → 200; the MCP
 * derives alreadyLinked from the 200-vs-201, but since the API client doesn't
 * surface the status we set alreadyLinked=false on success and rely on the API's
 * idempotency for safety).
 */
import { z } from 'zod'
import { ApiError } from '../errors.ts'
import {
  ProjectField,
  SessionId,
  ok,
  fromApiError,
  projectNudge,
  RO_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  WRITE_IDEMPOTENT_ANNOTATIONS,
} from '../schemas.ts'
import type { RegisterFn } from './context.ts'

const LinkSchema = {
  id: z.string(),
  investigationId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
}

const InvestigationShape = {
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  project: z.string(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
}

export const registerInvestigationTools: RegisterFn = (server, { api }) => {
  // ── create_investigation ──────────────────────────────────────────────────────
  server.registerTool(
    'create_investigation',
    {
      title: 'Create an investigation',
      description:
        'Create an investigation — a named container to group related memories/documents/claims for ' +
        'one inquiry. Own team only. `project` is REQUIRED (name the repo/project, or "general"). Link ' +
        'evidence with link_investigation.',
      inputSchema: {
        title: z.string().min(1).describe('Short investigation title. e.g. "Cross-team read regression"'),
        description: z.string().optional().describe('Optional longer description.'),
        project: ProjectField,
        status: z.string().optional().describe('Optional status; the API defaults if omitted. e.g. "open"'),
        sessionId: SessionId,
      },
      outputSchema: InvestigationShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      if (!input.project?.trim()) return projectNudge('create_investigation')
      try {
        const res = await api.post<Record<string, unknown>>('/investigations', {
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
          project: input.project,
          ...(input.status ? { status: input.status } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        })
        return ok(`Created investigation ${String(res.id)} ("${input.title}", project=${input.project}).`, res)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_investigation ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_investigation',
    {
      title: 'Get an investigation',
      description:
        'Fetch one investigation with all its linked evidence. An unreadable/absent id → not_found.',
      inputSchema: { id: z.string().uuid().describe('Investigation id. e.g. "…"') },
      outputSchema: { ...InvestigationShape, links: z.array(z.object(LinkSchema)) },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const res = await api.get<Record<string, unknown> & { links: unknown[] }>(
          `/investigations/${input.id}`,
        )
        return ok(
          `Investigation ${input.id} ("${String(res.title)}") with ${res.links.length} link(s).`,
          res,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── link_investigation ────────────────────────────────────────────────────────
  server.registerTool(
    'link_investigation',
    {
      title: 'Link evidence to an investigation',
      description:
        'Attach a piece of evidence (memory/document/source/chunk/claim/entity) to an investigation. ' +
        'Idempotent: re-linking the same target returns the existing link. Both the investigation and ' +
        'the target must be readable by you (else a not_found / target_not_found error).',
      inputSchema: {
        investigationId: z
          .string()
          .uuid()
          .describe('Investigation id from create_investigation. e.g. "…"'),
        targetType: z
          .enum(['memory', 'document', 'source', 'chunk', 'claim', 'entity'])
          .describe('Kind of evidence being linked. e.g. "document"'),
        targetId: z
          .string()
          .uuid()
          .describe('Id of the target evidence (must be readable by you). e.g. "…"'),
        note: z.string().optional().describe('Why this evidence matters. e.g. "shows the 403 root cause"'),
      },
      outputSchema: LinkSchema,
      annotations: WRITE_IDEMPOTENT_ANNOTATIONS,
    },
    async (input) => {
      try {
        const res = await api.post<Record<string, unknown>>(
          `/investigations/${input.investigationId}/links`,
          {
            targetType: input.targetType,
            targetId: input.targetId,
            ...(input.note ? { note: input.note } : {}),
          },
        )
        return ok(
          `Linked ${input.targetType} ${input.targetId} to investigation ${input.investigationId}.`,
          res,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )
}
