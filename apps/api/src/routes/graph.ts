/**
 * persistent-memory-api — Graphiti proxy endpoints. Map 1:1 to the MCP tools
 * search_graph / get_entity / get_timeline / get_contradictions. All require
 * team membership (the data plane rejects team-less callers).
 *
 * THE SINGLE RULE: group_ids is ALWAYS server-derived — NEVER from the
 * body/query. Each Graphiti group is exactly one memory surface + team + project.
 * A regular call reads the caller's `general` Personal-equivalent partition;
 * callers must explicitly name `projects` for a multi-project picture. Cross-team
 * facts are only from mounted teams and remain additional to the caller's own facts.
 *
 * Facts are tagged relation: 'own' | 'granted' (= other team) by group_id ===
 * identity.teamId, and own-team facts are listed first.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { KnowledgeFilters, type KnowledgeFilter } from '@pm/shared'
import { forbidden } from '../authz/errors.ts'
import { requireTeamMember } from '../authz/guards.ts'
import { graphiti } from '../services/graphiti.ts'
import { currentMemorySurface, graphProjectGroup } from '../services/graph-project-group.ts'
import { runInTenant, type Tx } from '@pm/db'
import type { GraphitiFactEdge } from '../clients/graphiti.ts'
import { knowledgeWhere } from '../services/knowledge.ts'

const Scope = z.literal('own').optional()
/** Direct graph routes require a named partition list; only the MCP chooses Personal `general`. */
export const GraphReadProjects = z
  .union([z.string().min(1).transform((project) => [project]), z.array(z.string().min(1)).min(1).max(20)]).optional()

const FactEdgeSchema = z.object({
  episodes: z.array(z.string()),
  sourceMemoryIds: z.array(z.string()),
  assertionStatus: z.string(),
  verification: z.literal('derived_source_reported'),
  uuid: z.string(),
  name: z.string().nullable(),
  fact: z.string().nullable(),
  source_node_uuid: z.string().nullable(),
  target_node_uuid: z.string().nullable(),
  source_name: z.string().nullable(),
  target_name: z.string().nullable(),
  group_id: z.string().nullable(),
  valid_at: z.string().nullable(),
  invalid_at: z.string().nullable(),
  project: z.string(),
  surface: z.enum(['personal', 'shared']),
  relation: z.enum(['own', 'granted']),
})

type GraphFactLabel = { project: string; surface: 'personal' | 'shared'; relation: 'own' | 'granted' }

/**
 * Resolve the exact project partitions a caller may read. The request can name
 * projects but never raw Graphiti groups.
 */
async function resolveGroupIds(
  req: FastifyRequest,
  scope: z.infer<typeof Scope>,
  filters: KnowledgeFilter,
): Promise<{ groupIds: string[]; labels: Map<string, GraphFactLabel> }> {
  const own = req.identity!.teamId! // guaranteed by requireTeamMember
  if (scope && scope !== 'own') throw forbidden('sharing_retired', 'Shared/mounted scope is retired; no cross-owner graph reads are permitted.')
  const teams = [own]
  const selectedProjects = await runInTenant(async (tx: Tx) => {
    const rows = await tx.memory.findMany({ where: { ...knowledgeWhere(filters), graphStatus: 'ok' }, distinct: ['project'], select: { project: true }, take: 100 })
    return rows.map(row => row.project)
  })
  const surface = currentMemorySurface()
  const labels = new Map<string, GraphFactLabel>()
  for (const teamId of teams) {
    for (const project of selectedProjects) {
      const groupId = graphProjectGroup(teamId, project)
      labels.set(groupId, { project, surface, relation: teamId === own ? 'own' : 'granted' })
    }
  }
  return {
    groupIds: [...labels.keys()],
    labels,
  }
}

/** Tag only known partitions with project/surface provenance and list own facts first. */
export function tagKnownGraphFacts<T extends GraphitiFactEdge>(
  facts: T[],
  labels: Map<string, GraphFactLabel>,
): Array<T & GraphFactLabel> {
  const tagged = facts.flatMap((fact) => {
    const label = fact.group_id ? labels.get(fact.group_id) : undefined
    return label ? [{ ...fact, ...label }] : []
  })
  return [
    ...tagged.filter((f) => f.relation === 'own'),
    ...tagged.filter((f) => f.relation === 'granted'),
  ]
}

/** A derived fact cannot outlive, cross ownership, or silently upgrade its sources. */
export async function currentGraphFacts<T extends GraphitiFactEdge>(facts: T[], labels: Map<string, GraphFactLabel>, projectsOrFilters?: string[] | KnowledgeFilter) {
  const filters = Array.isArray(projectsOrFilters) ? { projects: projectsOrFilters } : projectsOrFilters ?? {}
  const episodeIds = [...new Set(facts.flatMap(fact => fact.episodes ?? []))]
  if (!episodeIds.length) return []
  const rows = await runInTenant((tx: Tx) => tx.memory.findMany({ where: { ...knowledgeWhere(filters), graphStatus: 'ok', graphEpisodeId: { in: episodeIds } }, select: { id: true, graphEpisodeId: true, graphGroupId: true, assertionStatus: true, relationshipDependencies: true } }))
  const provenance = await runInTenant((tx: Tx) => tx.graphEpisodeProvenance.findMany({ where: { graphEpisodeId: { in: episodeIds }, subjectKind: 'memory' }, select: { subjectId: true, graphEpisodeId: true, graphGroupId: true } }))
  const authorized = await runInTenant((tx: Tx) => tx.memory.findMany({ where: { ...knowledgeWhere(filters), id: { in: provenance.map(item => item.subjectId) } }, select: { id: true, graphEpisodeId: true, relationshipDependencies: true } }))
  const dependencyIds = [...rows,...authorized].flatMap(row => Array.isArray(row.relationshipDependencies) ? row.relationshipDependencies.flatMap(value => value && typeof value === 'object' && 'targetMemoryId' in value ? [String(value.targetMemoryId)] : []) : [])
  const targets = dependencyIds.length ? await runInTenant((tx: Tx) => tx.memory.findMany({ where: { id: { in: dependencyIds } }, select: { id: true, revision: true } })) : []
  const targetVersions = new Map(targets.map(target => [target.id, target.revision]))
  const dependencyValid = (row: { relationshipDependencies: unknown }) => !Array.isArray(row.relationshipDependencies) || row.relationshipDependencies.every(value => value && typeof value === 'object' && 'targetMemoryId' in value && 'targetRevision' in value && targetVersions.get(String(value.targetMemoryId)) === value.targetRevision)
  const supported = rows.filter(dependencyValid)
  const byEpisode = new Map(supported.map(row => [row.graphEpisodeId, row]))
  const authorizedSubjects = new Map(authorized.filter(dependencyValid).map(row => [row.id, row]))
  return tagKnownGraphFacts(facts, labels).flatMap(fact => {
    const episodes = fact.episodes ?? []
    const current = episodes.filter(episode => byEpisode.get(episode)?.graphGroupId === fact.group_id)
    if (!current.length) return []
    // Old episodes from a still-authorized subject are obsolete support, not an
    // automatic veto on a fact that has current evidence. Unknown/foreign source
    // episodes remain fail-closed, and only current support is attributed below.
    if (!episodes.every(episode => current.includes(episode) || provenance.some(item => item.graphEpisodeId === episode && item.graphGroupId === fact.group_id && authorizedSubjects.has(item.subjectId) && authorizedSubjects.get(item.subjectId)!.graphEpisodeId !== episode))) return []
    const sources = current.map(episode => byEpisode.get(episode)!)
    const statuses = [...new Set(sources.map(source => source.assertionStatus))]
    return [{ ...fact, episodes: current, sourceMemoryIds: [...new Set(sources.map(source => source.id))], assertionStatus: statuses.length === 1 ? statuses[0]! : 'inference', verification: 'derived_source_reported' as const }]
  })

}

export async function graphRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── POST /graph/search — search_graph ──────────────────────────────────────
  const SearchBody = z
    .object({
      ...KnowledgeFilters.shape,
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(10),
      centerNodeUuid: z.string().optional(),
      validOnly: z.boolean().default(false),
      scope: Scope,
      projects: GraphReadProjects,
    })
    .strict()

  z4.post(
    '/graph/search',
    {
      preHandler: [requireTeamMember],
      schema: {
        body: SearchBody,
        response: { 200: z.object({ facts: z.array(FactEdgeSchema) }), 403: z.object({ error: z.string(), message: z.string() }), 502: z.object({ error: z.string(), message: z.string() }) },
      },
    },
    async (req, reply) => {
      const groups = await resolveGroupIds(req, req.body.scope, req.body)
      if (!groups.groupIds.length) return reply.code(200).send({ facts: [] })
      const res = await graphiti.search({
        query: req.body.query,
        groupIds: groups.groupIds,
        limit: req.body.limit,
        centerNodeUuid: req.body.centerNodeUuid,
        validOnly: req.body.validOnly,
      })
      return reply.code(200).send({ facts: await currentGraphFacts(res.facts, groups.labels, req.body) })
    },
  )

  // ── GET /graph/entity/:name — get_entity ────────────────────────────────────
  // No Graphiti /entity/:name endpoint and no persisted Postgres↔node-uuid map
  // (the worker discards episode node uuids) → composed from search(query=name)
  // + an optional timeline. An absent entity → empty result, NOT 404.
  const EntityQuery = z.object({
    ...KnowledgeFilters.shape,
    scope: Scope,
    projects: GraphReadProjects,
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  z4.get(
    '/graph/entity/:name',
    {
      preHandler: [requireTeamMember],
      schema: {
        params: z.object({ name: z.string().min(1) }),
        querystring: EntityQuery,
        response: {
          200: z.object({ name: z.string(), facts: z.array(FactEdgeSchema) }),
          403: z.object({ error: z.string(), message: z.string() }),
          502: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const groups = await resolveGroupIds(req, req.query.scope, req.query)
      if (!groups.groupIds.length) return reply.code(200).send({ name: req.params.name, facts: [] })
      const res = await graphiti.search({
        query: req.params.name,
        groupIds: groups.groupIds,
        limit: req.query.limit,
      })
      return reply
        .code(200)
        .send({ name: req.params.name, facts: await currentGraphFacts(res.facts, groups.labels, req.query) })
    },
  )

  // ── GET /graph/timeline — get_timeline ──────────────────────────────────────
  const TimelineEntrySchema = FactEdgeSchema.extend({ status: z.enum(['valid', 'invalid']) })
  const TimelineQuery = z.object({
    ...KnowledgeFilters.shape,
    entityUuid: z.string().optional(),
    includeInvalid: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .default(true),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    scope: Scope,
    projects: GraphReadProjects,
  })
  z4.get(
    '/graph/timeline',
    {
      preHandler: [requireTeamMember],
      schema: {
        querystring: TimelineQuery,
        response: {
          200: z.object({
            entityUuid: z.string().nullable(),
            entries: z.array(TimelineEntrySchema),
          }),
          403: z.object({ error: z.string(), message: z.string() }),
          502: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const groups = await resolveGroupIds(req, req.query.scope, req.query)
      if (!groups.groupIds.length) return reply.code(200).send({ entityUuid: req.query.entityUuid ?? null, entries: [] })
      const res = await graphiti.timeline({
        groupIds: groups.groupIds,
        entityUuid: req.query.entityUuid,
        includeInvalid: req.query.includeInvalid,
        limit: req.query.limit,
      })
      const ordered = await currentGraphFacts(res.entries, groups.labels, req.query)
      return reply.code(200).send({ entityUuid: res.entity_uuid, entries: ordered })
    },
  )

  // ── GET /graph/contradictions — get_contradictions ──────────────────────────
  // Preserves superseded_by === null (an in-text-stated expiry).
  const ContradictionSchema = z.object({
    superseded: FactEdgeSchema,
    superseded_by: FactEdgeSchema.nullable(),
  })
  const ContradictionsQuery = z.object({
    ...KnowledgeFilters.shape,
    entityUuid: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    scope: Scope,
    projects: GraphReadProjects,
  })
  z4.get(
    '/graph/contradictions',
    {
      preHandler: [requireTeamMember],
      schema: {
        querystring: ContradictionsQuery,
        response: {
          200: z.object({ contradictions: z.array(ContradictionSchema) }),
          403: z.object({ error: z.string(), message: z.string() }),
          502: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const groups = await resolveGroupIds(req, req.query.scope, req.query)
      if (!groups.groupIds.length) return reply.code(200).send({ contradictions: [] })
      const res = await graphiti.contradictions({
        groupIds: groups.groupIds,
        entityUuid: req.query.entityUuid,
        limit: req.query.limit,
      })
      const contradictions = []
      for (const item of res.contradictions) {
        const superseded = (await currentGraphFacts([item.superseded], groups.labels, req.query))[0]
        const supersededBy = item.superseded_by ? (await currentGraphFacts([item.superseded_by], groups.labels, req.query))[0] : null
        if (superseded && (!item.superseded_by || supersededBy)) contradictions.push({ superseded, superseded_by: supersededBy ?? null })
      }
      return reply.code(200).send({ contradictions })
    },
  )
}
