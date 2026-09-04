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
import { forbidden } from '../authz/errors.ts'
import { requireTeamMember } from '../authz/guards.ts'
import { graphiti } from '../services/graphiti.ts'
import { currentMemorySurface, graphProjectGroup } from '../services/graph-project-group.ts'
import type { GraphitiFactEdge } from '../clients/graphiti.ts'

const Scope = z.union([z.enum(['own', 'granted']), z.array(z.string())]).optional()
/** Direct graph routes require a named partition list; only the MCP chooses Personal `general`. */
export const GraphReadProjects = z
  .union([z.string().min(1).transform((project) => [project]), z.array(z.string().min(1)).min(1).max(20)])

const FactEdgeSchema = z.object({
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
  projects: z.infer<typeof GraphReadProjects>,
): Promise<{ groupIds: string[]; labels: Map<string, GraphFactLabel> }> {
  const own = req.identity!.teamId! // guaranteed by requireTeamMember
  const mounted = req.identity!.mountedTeamIds
  const readableTeams = [own, ...mounted]
  let teams: string[]
  if (!scope || scope === 'own') teams = [own]
  else if (scope === 'granted') teams = mounted
  else {
    teams = scope
  }
  if (Array.isArray(scope)) {
    for (const t of scope) {
      if (!readableTeams.includes(t)) {
        throw forbidden(
          'scope_not_readable',
          `Team "${t}" is not mounted for graph reads. scope can only narrow to your team or a mounted team.`,
        )
      }
    }
  }
  const selectedProjects = projects
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

export async function graphRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── POST /graph/search — search_graph ──────────────────────────────────────
  const SearchBody = z
    .object({
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
      const groups = await resolveGroupIds(req, req.body.scope, req.body.projects)
      const res = await graphiti.search({
        query: req.body.query,
        groupIds: groups.groupIds,
        limit: req.body.limit,
        centerNodeUuid: req.body.centerNodeUuid,
        validOnly: req.body.validOnly,
      })
      return reply.code(200).send({ facts: tagKnownGraphFacts(res.facts, groups.labels) })
    },
  )

  // ── GET /graph/entity/:name — get_entity ────────────────────────────────────
  // No Graphiti /entity/:name endpoint and no persisted Postgres↔node-uuid map
  // (the worker discards episode node uuids) → composed from search(query=name)
  // + an optional timeline. An absent entity → empty result, NOT 404.
  const EntityQuery = z.object({
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
      const groups = await resolveGroupIds(req, req.query.scope, req.query.projects)
      const res = await graphiti.search({
        query: req.params.name,
        groupIds: groups.groupIds,
        limit: req.query.limit,
      })
      return reply
        .code(200)
        .send({ name: req.params.name, facts: tagKnownGraphFacts(res.facts, groups.labels) })
    },
  )

  // ── GET /graph/timeline — get_timeline ──────────────────────────────────────
  const TimelineEntrySchema = FactEdgeSchema.extend({ status: z.enum(['valid', 'invalid']) })
  const TimelineQuery = z.object({
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
      const groups = await resolveGroupIds(req, req.query.scope, req.query.projects)
      const res = await graphiti.timeline({
        groupIds: groups.groupIds,
        entityUuid: req.query.entityUuid,
        includeInvalid: req.query.includeInvalid,
        limit: req.query.limit,
      })
      const ordered = tagKnownGraphFacts(res.entries, groups.labels)
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
      const groups = await resolveGroupIds(req, req.query.scope, req.query.projects)
      const res = await graphiti.contradictions({
        groupIds: groups.groupIds,
        entityUuid: req.query.entityUuid,
        limit: req.query.limit,
      })
      const contradictions = res.contradictions.flatMap((contradiction) => {
        const superseded = tagKnownGraphFacts([contradiction.superseded], groups.labels).at(0)
        const successor = contradiction.superseded_by
          ? tagKnownGraphFacts([contradiction.superseded_by], groups.labels).at(0)
          : null
        return superseded && (!contradiction.superseded_by || successor)
          ? [{ superseded, superseded_by: successor ?? null }]
          : []
      })
      return reply.code(200).send({ contradictions })
    },
  )
}
