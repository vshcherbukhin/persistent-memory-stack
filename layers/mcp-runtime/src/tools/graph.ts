/**
 * Temporal knowledge-graph tools (map 1:1 to /graph/*):
 *   search_graph, get_entity, get_timeline, get_contradictions.
 *
 * All read-only, all take an optional subtractive `scope`. group_ids is derived
 * server-side from readableTeams (the MCP never sends one). Errors include 403
 * scope_not_readable and 502 (graph backend down).
 */
import { z } from 'zod'
import { ApiError } from '../errors.ts'
import { FactEdge, GraphProjects, Scope, ok, fromApiError, graphResponseContractError, graphContradictionResponseContractError, RO_ANNOTATIONS } from '../schemas.ts'
import type { RegisterFn } from './context.ts'
import { memorySurfaceField, selectMemoryContext } from './memories.ts'

async function graphContexts(server: Parameters<RegisterFn>[0], api: Parameters<RegisterFn>[1]['api'], runtime: Parameters<RegisterFn>[1]['runtime'], surface: 'personal' | 'shared' | undefined, projects: string[] | undefined) {
  const names = projects?.length ? projects : ['general']
  const contexts = await Promise.all(names.map(async (project) => ({ project, ctx: await selectMemoryContext(server, api, runtime, surface, project) })))
  const failure = contexts.find((entry) => !entry.ctx.ok)
  if (failure && !failure.ctx.ok) return { error: failure.ctx.error }
  return { contexts: contexts as Array<{ project: string; ctx: Extract<(typeof contexts)[number]['ctx'], { ok: true }> }> }
}

export const registerGraphTools: RegisterFn = (server, { api, runtime }) => {
  const MemorySurfaceField = memorySurfaceField(runtime)
  // ── search_graph ─────────────────────────────────────────────────────────────
  server.registerTool(
    'search_graph',
    {
      title: 'Search the knowledge graph',
      description:
        'Graph-RAG search over the temporal knowledge graph (entities + relationship facts), own facts ' +
        'first. Use as the graph-expand step between vector search and targeted recall, or to find how ' +
        'two entities relate.',
      inputSchema: {
        surface: MemorySurfaceField,
        query: z
          .string()
          .min(1)
          .describe('Entity/relationship search text. e.g. "AuthGuard rejects read tokens"'),
        limit: z.number().int().min(1).max(100).default(10).describe('Max facts. e.g. 10'),
        centerNodeUuid: z
          .string()
          .optional()
          .describe('Re-rank around this node uuid (graph proximity). e.g. a node uuid from a prior fact'),
        validOnly: z
          .boolean()
          .default(false)
          .describe('true = only currently-valid facts (invalid_at IS NULL). e.g. true'),
        scope: Scope,
        projects: GraphProjects,
      },
      outputSchema: { facts: z.array(FactEdge) },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const resolved = await graphContexts(server, api, runtime, input.surface, input.projects)
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error ?? 'Unable to resolve the project memory surface.' }], isError: true }
        const results = await Promise.all(resolved.contexts.map(({ project, ctx }) => ctx.api.post<{ facts: unknown[] }>('/graph/search', {
          query: input.query,
          limit: input.limit,
          ...(input.centerNodeUuid ? { centerNodeUuid: input.centerNodeUuid } : {}),
          validOnly: input.validOnly,
          ...(input.scope ? { scope: input.scope } : {}),
          projects: [project],
        })))
        const res = { facts: results.flatMap((result) => result.facts) }
        const contractError = graphResponseContractError('search_graph', res.facts)
        if (contractError) return contractError
        return ok(`${res.facts.length} fact(s) found.`, res as unknown as Record<string, unknown>)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_entity ───────────────────────────────────────────────────────────────
  server.registerTool(
    'get_entity',
    {
      title: 'Expand an entity',
      description:
        'Fetch the relationship facts touching one named entity (own-first). Empty facts = no such ' +
        'entity in your readable graph (this is NOT an error).',
      inputSchema: {
        surface: MemorySurfaceField,
        name: z.string().min(1).describe('Entity name to expand. e.g. "component_AuthGuard"'),
        limit: z.coerce.number().int().min(1).max(100).default(20).describe('Max facts. e.g. 20'),
        scope: Scope,
        projects: GraphProjects,
      },
      outputSchema: { name: z.string(), facts: z.array(FactEdge) },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const resolved = await graphContexts(server, api, runtime, input.surface, input.projects)
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error ?? 'Unable to resolve the project memory surface.' }], isError: true }
        const results = await Promise.all(resolved.contexts.map(({ project, ctx }) => ctx.api.get<{ name: string; facts: unknown[] }>(
          `/graph/entity/${encodeURIComponent(input.name)}`,
          { limit: input.limit, scope: input.scope, projects: [project] },
        )))
        const res = { name: input.name, facts: results.flatMap((result) => result.facts) }
        const contractError = graphResponseContractError('get_entity', res.facts)
        if (contractError) return contractError
        return ok(`Entity "${input.name}": ${res.facts.length} fact(s).`, res as unknown as Record<string, unknown>)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_timeline ───────────────────────────────────────────────────────────────
  server.registerTool(
    'get_timeline',
    {
      title: 'Get a fact timeline',
      description:
        'Chronological timeline of facts (ordered by valid_at), each tagged valid/invalid. Use to see ' +
        'how a fact evolved over time, optionally for one entity node.',
      inputSchema: {
        surface: MemorySurfaceField,
        entityUuid: z
          .string()
          .optional()
          .describe('Restrict the timeline to facts about this node uuid. e.g. a node uuid'),
        includeInvalid: z
          .boolean()
          .default(true)
          .describe('Include superseded (invalid_at non-null) facts. e.g. true'),
        limit: z.coerce.number().int().min(1).max(1000).default(100).describe('Max entries. e.g. 100'),
        scope: Scope,
        projects: GraphProjects,
      },
      outputSchema: {
        entityUuid: z.string().nullable(),
        entries: z.array(FactEdge.extend({ status: z.enum(['valid', 'invalid']) })),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const resolved = await graphContexts(server, api, runtime, input.surface, input.projects)
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error ?? 'Unable to resolve the project memory surface.' }], isError: true }
        const results = await Promise.all(resolved.contexts.map(({ project, ctx }) => ctx.api.get<{ entityUuid: string | null; entries: unknown[] }>('/graph/timeline', {
          entityUuid: input.entityUuid,
          includeInvalid: input.includeInvalid,
          limit: input.limit,
          scope: input.scope,
          projects: [project],
        })))
        const res = { entityUuid: input.entityUuid ?? results.find((result) => result.entityUuid)?.entityUuid ?? null, entries: results.flatMap((result) => result.entries) }
        const contractError = graphResponseContractError('get_timeline', res.entries)
        if (contractError) return contractError
        return ok(`${res.entries.length} timeline entry(ies).`, res as unknown as Record<string, unknown>)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_contradictions ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_contradictions',
    {
      title: 'Find contradicted facts',
      description:
        'List facts that were contradicted/superseded by a later fact (each shows the old fact + what ' +
        'replaced it, or null if it just expired). Use to detect stale knowledge and resolve conflicts.',
      inputSchema: {
        surface: MemorySurfaceField,
        entityUuid: z.string().optional().describe('Restrict to contradictions about this node uuid.'),
        limit: z.coerce.number().int().min(1).max(1000).default(100).describe('Max pairs. e.g. 100'),
        scope: Scope,
        projects: GraphProjects,
      },
      outputSchema: {
        contradictions: z.array(
          z.object({ superseded: FactEdge, superseded_by: FactEdge.nullable() }),
        ),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      try {
        const resolved = await graphContexts(server, api, runtime, input.surface, input.projects)
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error ?? 'Unable to resolve the project memory surface.' }], isError: true }
        const results = await Promise.all(resolved.contexts.map(({ project, ctx }) => ctx.api.get<{ contradictions: unknown[] }>('/graph/contradictions', {
          entityUuid: input.entityUuid,
          limit: input.limit,
          scope: input.scope,
          projects: [project],
        })))
        const res = { contradictions: results.flatMap((result) => result.contradictions) }
        const contractError = graphContradictionResponseContractError('get_contradictions', res.contradictions)
        if (contractError) return contractError
        return ok(`${res.contradictions.length} contradiction(s).`, res as unknown as Record<string, unknown>)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )
}
