/**
 * Dashboard Memory Graph read model.
 *
 * The browser receives only bounded, metadata-safe graph DTOs. Tenant scope is
 * established by runInTenant/RLS and Graphiti group ids are always derived on
 * the server from readable rows; a request can narrow projects but can never
 * widen team access or name a raw group id.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { Prisma, runInTenant, type Tx } from '@pm/db'
import { requireTeamMember } from '../authz/guards.ts'
import { config } from '../config.ts'
import { graphiti } from '../services/graphiti.ts'
import { currentMemorySurface, graphProjectGroup } from '../services/graph-project-group.ts'

const Relation = z.enum(['own', 'granted'])
const Surface = z.enum(['personal', 'shared'])
const ActivityKind = z.enum(['created', 'updated', 'read'])

const GraphNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(['memory', 'entity']),
  displayLabel: z.string(),
  project: z.string(),
  category: z.string().nullable(),
  relation: Relation,
  surface: Surface,
  memoryId: z.string().nullable(),
  entityUuid: z.string().nullable(),
  graphStatus: z.string().nullable(),
})

const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.enum(['mentions', 'fact']),
  label: z.string().nullable(),
  historical: z.boolean(),
  project: z.string(),
  relation: Relation,
  surface: Surface,
})

const FacetSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
  lastChangedAt: z.string(),
})

const ActivitySchema = z.object({
  memoryId: z.string(),
  kind: ActivityKind,
  occurredAt: z.string(),
  project: z.string(),
  category: z.string(),
  entities: z.array(z.string()),
  displayLabel: z.string(),
})

const StringList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    const values = value === undefined ? [] : Array.isArray(value) ? value : [value]
    return [...new Set(values.flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean))]
  })

const FilterQuery = z.object({
  projects: StringList,
  tags: StringList,
  badges: StringList,
  validity: z.enum(['all', 'current', 'historical']).default('all'),
})

type GraphFilters = z.infer<typeof FilterQuery>
type RelationValue = z.infer<typeof Relation>
type SurfaceValue = z.infer<typeof Surface>

interface MemoryGraphRow {
  id: string
  teamId: string
  project: string
  category: string
  entities: string[]
  graphStatus: string
  createdAt: Date
  recordUpdatedAt: Date
  lastAccessedAt: Date | null
}

interface SignedCursor {
  v: 1
  kind: 'snapshot' | 'activity'
  scope: string
  lastMemoryId?: string | null
  loadedMemories?: number
  memoriesComplete?: boolean
  factAfterAt?: string | null
  factAfterUuid?: string | null
  factsComplete?: boolean
  since?: string
  until?: string
  lastActivityMemoryId?: string
}

const CURSOR_SECRET = config.TOKEN_PEPPER || config.GRAPH_GROUP_SECRET || 'persistent-memory-local-cursor'

function scopeHash(filters: GraphFilters, teamId: string, mountedTeamIds: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ teamId, mountedTeamIds: [...mountedTeamIds].sort(), filters }))
    .digest('base64url')
}

function signCursor(value: SignedCursor): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  const signature = createHmac('sha256', CURSOR_SECRET).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function readCursor(raw: string | undefined, kind: SignedCursor['kind'], scope: string): SignedCursor | null {
  if (!raw) return null
  const [payload, signature] = raw.split('.')
  if (!payload || !signature) return null
  const expected = createHmac('sha256', CURSOR_SECRET).update(payload).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedCursor
    return parsed.v === 1 && parsed.kind === kind && parsed.scope === scope ? parsed : null
  } catch {
    return null
  }
}

function memoryWhere(filters: GraphFilters): Prisma.MemoryWhereInput {
  return {
    ...(filters.projects.length > 0 ? { project: { in: filters.projects } } : {}),
    ...(filters.badges.length > 0 ? { category: { in: filters.badges } } : {}),
    ...(filters.tags.length > 0 ? { entities: { hasSome: filters.tags } } : {}),
  }
}

function relationFor(teamId: string, ownTeamId: string): RelationValue {
  return teamId === ownTeamId ? 'own' : 'granted'
}

function entityKey(groupId: string, name: string): string {
  const normalized = name.trim().toLocaleLowerCase()
  return `entity:${createHash('sha256').update(`${groupId}\u0000${normalized}`).digest('base64url').slice(0, 22)}`
}

function safeMemoryLabel(id: string, category: string): string {
  return `${category} memory ${id.slice(0, 8)}`
}

const MEMORY_SELECT = {
  id: true,
  teamId: true,
  project: true,
  category: true,
  entities: true,
  graphStatus: true,
  createdAt: true,
  recordUpdatedAt: true,
  lastAccessedAt: true,
} as const

function appendMemoryTopology(
  rows: MemoryGraphRow[],
  ownTeamId: string,
  surface: SurfaceValue,
  nodes: Map<string, z.infer<typeof GraphNodeSchema>>,
  edges: Map<string, z.infer<typeof GraphEdgeSchema>>,
): void {
  for (const row of rows) {
    const relation = relationFor(row.teamId, ownTeamId)
    const memoryNodeId = `memory:${row.id}`
    nodes.set(memoryNodeId, {
      id: memoryNodeId,
      kind: 'memory',
      displayLabel: safeMemoryLabel(row.id, row.category),
      project: row.project,
      category: row.category,
      relation,
      surface,
      memoryId: row.id,
      entityUuid: null,
      graphStatus: row.graphStatus,
    })
    const groupId = graphProjectGroup(row.teamId, row.project)
    for (const entity of row.entities) {
      const name = entity.trim()
      if (!name) continue
      const entityId = entityKey(groupId, name)
      if (!nodes.has(entityId)) {
        nodes.set(entityId, {
          id: entityId,
          kind: 'entity',
          displayLabel: name,
          project: row.project,
          category: null,
          relation,
          surface,
          memoryId: null,
          entityUuid: null,
          graphStatus: null,
        })
      }
      const edgeId = `mention:${row.id}:${entityId}`
      edges.set(edgeId, {
        id: edgeId,
        source: memoryNodeId,
        target: entityId,
        kind: 'mentions',
        label: null,
        historical: false,
        project: row.project,
        relation,
        surface,
      })
    }
  }
}

export async function memoryGraphRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  const SnapshotQuery = FilterQuery.extend({
    cursor: z.string().optional(),
    memoryLimit: z.coerce.number().int().min(20).max(200).default(100),
    factLimit: z.coerce.number().int().min(20).max(500).default(250),
  })

  z4.get('/graph/snapshot', {
    preHandler: [requireTeamMember],
    schema: {
      querystring: SnapshotQuery,
      response: {
        200: z.object({
          nodes: z.array(GraphNodeSchema),
          edges: z.array(GraphEdgeSchema),
          counts: z.object({
            totalFilteredMemories: z.number().int().nonnegative(),
            loadedMemories: z.number().int().nonnegative(),
            loadedEntities: z.number().int().nonnegative(),
            loadedEdges: z.number().int().nonnegative(),
          }),
          partial: z.boolean(),
          partialReason: z.string().nullable(),
          nextCursor: z.string().nullable(),
          graphRevision: z.string(),
          snapshotAt: z.string(),
        }),
        400: z.union([
          z.object({ error: z.string(), message: z.string() }),
          z.object({ error: z.literal('validation_error'), issues: z.unknown() }),
        ]),
      },
    },
  }, async (req, reply) => {
    const identity = req.identity!
    const filters: GraphFilters = {
      projects: req.query.projects,
      tags: req.query.tags,
      badges: req.query.badges,
      validity: req.query.validity,
    }
    const scope = scopeHash(filters, identity.teamId!, identity.mountedTeamIds)
    const cursor = readCursor(req.query.cursor, 'snapshot', scope)
    if (req.query.cursor && !cursor) {
      return reply.code(400).send({ error: 'invalid_graph_cursor', message: 'The graph cursor is invalid or belongs to different filters.' })
    }
    const loadedBefore = cursor?.loadedMemories ?? 0
    const where = memoryWhere(filters)
    const snapshotAt = new Date()

    const result = await runInTenant(async (tx: Tx) => {
      const [rows, total, projectRows, revision] = await Promise.all([
        tx.memory.findMany({
          where,
          ...(!cursor?.memoriesComplete && cursor?.lastMemoryId ? { cursor: { id: cursor.lastMemoryId }, skip: 1 } : {}),
          take: cursor?.memoriesComplete ? 0 : req.query.memoryLimit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: MEMORY_SELECT,
        }) as PromiseLike<MemoryGraphRow[]>,
        tx.memory.count({ where }),
        tx.memory.findMany({ where, distinct: ['teamId', 'project'], select: { teamId: true, project: true } }),
        tx.memory.aggregate({
          where,
          _max: { createdAt: true, recordUpdatedAt: true, lastAccessedAt: true },
        }),
      ])
      return { rows, total, projectRows, revision }
    })

    const surface = currentMemorySurface()
    const nodes = new Map<string, z.infer<typeof GraphNodeSchema>>()
    const edges = new Map<string, z.infer<typeof GraphEdgeSchema>>()
    appendMemoryTopology(result.rows, identity.teamId!, surface, nodes, edges)

    const groupLabels = new Map<string, { project: string; relation: RelationValue }>()
    for (const projectRow of result.projectRows) {
      const groupId = graphProjectGroup(projectRow.teamId, projectRow.project)
      groupLabels.set(groupId, {
        project: projectRow.project,
        relation: relationFor(projectRow.teamId, identity.teamId!),
      })
    }

    let nextFactAfterAt: string | null = null
    let nextFactAfterUuid: string | null = null
    let factsComplete = cursor?.factsComplete ?? groupLabels.size === 0
    let partialReason: string | null = null
    try {
      if (groupLabels.size > 0 && !factsComplete) {
        const timeline = await graphiti.timeline({
          groupIds: [...groupLabels.keys()],
          includeInvalid: true,
          limit: req.query.factLimit,
          afterAt: cursor?.factAfterAt ?? undefined,
          afterUuid: cursor?.factAfterUuid ?? undefined,
        })
        const facts = timeline.entries.filter((fact) => req.query.validity === 'all' || (req.query.validity === 'current' ? fact.status === 'valid' : fact.status === 'invalid'))
        nextFactAfterAt = timeline.next_after_at
        nextFactAfterUuid = timeline.next_after_uuid
        factsComplete = !nextFactAfterAt || !nextFactAfterUuid
        for (const fact of facts) {
          if (!fact.group_id) continue
          const label = groupLabels.get(fact.group_id)
          const sourceName = fact.source_name?.trim()
          const targetName = fact.target_name?.trim()
          if (!label || !sourceName || !targetName) continue
          const sourceId = entityKey(fact.group_id, sourceName)
          const targetId = entityKey(fact.group_id, targetName)
          for (const [id, name, entityUuid] of [
            [sourceId, sourceName, fact.source_node_uuid],
            [targetId, targetName, fact.target_node_uuid],
          ] as const) {
            if (!nodes.has(id)) nodes.set(id, {
              id,
              kind: 'entity',
              displayLabel: name,
              project: label.project,
              category: null,
              relation: label.relation,
              surface,
              memoryId: null,
              entityUuid,
              graphStatus: null,
            })
          }
          edges.set(`fact:${fact.uuid}`, {
            id: `fact:${fact.uuid}`,
            source: sourceId,
            target: targetId,
            kind: 'fact',
            label: fact.name ?? fact.fact,
            historical: fact.status === 'invalid',
            project: label.project,
            relation: label.relation,
            surface,
          })
        }
      }
    } catch {
      factsComplete = true
      partialReason = 'Live fact relationships are temporarily unavailable; memory-to-entity links are still shown.'
    }

    const loadedMemories = loadedBefore + result.rows.length
    const moreMemories = !cursor?.memoriesComplete && loadedMemories < result.total
    const nextCursor = moreMemories || !factsComplete
      ? signCursor({
          v: 1,
          kind: 'snapshot',
          scope,
          lastMemoryId: moreMemories ? result.rows.at(-1)?.id ?? cursor?.lastMemoryId ?? null : null,
          loadedMemories,
          memoriesComplete: !moreMemories,
          factAfterAt: nextFactAfterAt ?? cursor?.factAfterAt ?? null,
          factAfterUuid: nextFactAfterUuid ?? cursor?.factAfterUuid ?? null,
          factsComplete,
        })
      : null
    const revisionSource = JSON.stringify({ scope, total: result.total, revision: result.revision })
    const graphRevision = createHash('sha256').update(revisionSource).digest('base64url').slice(0, 20)
    const entityCount = [...nodes.values()].filter((node) => node.kind === 'entity').length

    return reply.code(200).send({
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      counts: {
        totalFilteredMemories: result.total,
        loadedMemories,
        loadedEntities: entityCount,
        loadedEdges: edges.size,
      },
      partial: nextCursor !== null || partialReason !== null,
      partialReason,
      nextCursor,
      graphRevision,
      snapshotAt: snapshotAt.toISOString(),
    })
  })

  const FacetsQuery = z.object({
    search: z.string().max(64).optional(),
    facet: z.enum(['projects', 'tags', 'badges']).optional(),
    recent: z.coerce.number().int().min(4).max(30).default(12),
  })
  z4.get('/graph/facets', {
    preHandler: [requireTeamMember],
    schema: {
      querystring: FacetsQuery,
      response: {
        200: z.object({
          projects: z.array(FacetSchema),
          tags: z.array(FacetSchema),
          badges: z.array(FacetSchema),
          partial: z.boolean(),
        }),
      },
    },
  }, async (req, reply) => {
    const rows = await runInTenant((tx: Tx) => tx.memory.findMany({
      take: 5001,
      orderBy: [{ recordUpdatedAt: 'desc' }, { id: 'desc' }],
      select: { project: true, category: true, entities: true, recordUpdatedAt: true },
    }))
    const partial = rows.length > 5000
    const search = req.query.search?.trim().toLocaleLowerCase() ?? ''
    const tally = (values: Array<{ value: string; at: Date }>, facet: 'projects' | 'tags' | 'badges'): z.infer<typeof FacetSchema>[] => {
      const map = new Map<string, { count: number; lastChangedAt: Date }>()
      for (const item of values) {
        if ((!req.query.facet || req.query.facet === facet) && search && !item.value.toLocaleLowerCase().includes(search)) continue
        const current = map.get(item.value)
        map.set(item.value, {
          count: (current?.count ?? 0) + 1,
          lastChangedAt: !current || item.at > current.lastChangedAt ? item.at : current.lastChangedAt,
        })
      }
      return [...map.entries()]
        .map(([value, valueMeta]) => ({ value, count: valueMeta.count, lastChangedAt: valueMeta.lastChangedAt.toISOString() }))
        .sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt) || b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, req.query.recent)
    }
    const bounded = rows.slice(0, 5000)
    return reply.code(200).send({
      projects: tally(bounded.map((row) => ({ value: row.project, at: row.recordUpdatedAt })), 'projects'),
      badges: tally(bounded.map((row) => ({ value: row.category, at: row.recordUpdatedAt })), 'badges'),
      tags: tally(bounded.flatMap((row) => row.entities.map((value) => ({ value, at: row.recordUpdatedAt }))), 'tags'),
      partial,
    })
  })

  const ActivityQuery = FilterQuery.extend({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).default(100),
  })
  z4.get('/graph/activity', {
    preHandler: [requireTeamMember],
    schema: {
      querystring: ActivityQuery,
      response: {
        200: z.object({
          events: z.array(ActivitySchema),
          nextCursor: z.string(),
          partial: z.boolean(),
          serverTime: z.string(),
        }),
        400: z.union([
          z.object({ error: z.string(), message: z.string() }),
          z.object({ error: z.literal('validation_error'), issues: z.unknown() }),
        ]),
      },
    },
  }, async (req, reply) => {
    const identity = req.identity!
    const filters: GraphFilters = {
      projects: req.query.projects,
      tags: req.query.tags,
      badges: req.query.badges,
      validity: req.query.validity,
    }
    const scope = scopeHash(filters, identity.teamId!, identity.mountedTeamIds)
    const cursor = readCursor(req.query.cursor, 'activity', scope)
    if (req.query.cursor && !cursor) {
      return reply.code(400).send({ error: 'invalid_graph_cursor', message: 'The activity cursor is invalid or belongs to different filters.' })
    }
    const serverTime = new Date()
    if (!cursor?.since) {
      return reply.code(200).send({
        events: [],
        nextCursor: signCursor({ v: 1, kind: 'activity', scope, since: serverTime.toISOString() }),
        partial: false,
        serverTime: serverTime.toISOString(),
      })
    }
    const requestedSince = new Date(cursor.since)
    const requestedUntil = cursor.until ? new Date(cursor.until) : serverTime
    // Once a burst page fixes an `until` boundary, retain the original bounded
    // start until every row in that window has been consumed.
    const since = cursor.until
      ? requestedSince
      : new Date(Math.max(requestedSince.getTime(), serverTime.getTime() - 60_000))
    const until = requestedUntil > serverTime ? serverTime : requestedUntil
    if (Number.isNaN(requestedSince.getTime()) || Number.isNaN(requestedUntil.getTime()) || until <= since) {
      return reply.code(200).send({
        events: [],
        nextCursor: signCursor({ v: 1, kind: 'activity', scope, since: serverTime.toISOString() }),
        partial: false,
        serverTime: serverTime.toISOString(),
      })
    }
    const baseWhere = memoryWhere(filters)
    const rows = await runInTenant((tx: Tx) => tx.memory.findMany({
      where: {
        ...baseWhere,
        ...(cursor.lastActivityMemoryId ? { id: { gt: cursor.lastActivityMemoryId } } : {}),
        OR: [
          { createdAt: { gt: since, lte: until } },
          { recordUpdatedAt: { gt: since, lte: until } },
          { lastAccessedAt: { gt: since, lte: until } },
        ],
      },
      take: req.query.limit + 1,
      orderBy: [{ id: 'asc' }],
      select: MEMORY_SELECT,
    }) as PromiseLike<MemoryGraphRow[]>)

    const events: z.infer<typeof ActivitySchema>[] = []
    for (const row of rows.slice(0, req.query.limit)) {
      const push = (kind: z.infer<typeof ActivityKind>, at: Date | null): void => {
        if (!at || at <= since || at > until) return
        events.push({
          memoryId: row.id,
          kind,
          occurredAt: at.toISOString(),
          project: row.project,
          category: row.category,
          entities: row.entities,
          displayLabel: safeMemoryLabel(row.id, row.category),
        })
      }
      push('created', row.createdAt)
      if (Math.abs(row.recordUpdatedAt.getTime() - row.createdAt.getTime()) > 1000) {
        push('updated', row.recordUpdatedAt)
      }
      push('read', row.lastAccessedAt)
    }
    events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.memoryId.localeCompare(b.memoryId))
    const partial = rows.length > req.query.limit
    const pageLastId = rows.slice(0, req.query.limit).at(-1)?.id
    return reply.code(200).send({
      events,
      nextCursor: partial && pageLastId
        ? signCursor({
            v: 1,
            kind: 'activity',
            scope,
            since: since.toISOString(),
            until: until.toISOString(),
            lastActivityMemoryId: pageLastId,
          })
        : signCursor({ v: 1, kind: 'activity', scope, since: until.toISOString() }),
      partial,
      serverTime: serverTime.toISOString(),
    })
  })
}
