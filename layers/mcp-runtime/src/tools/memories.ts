/**
 * Agent-memory tools (map 1:1 to /memories*, /entities):
 *   add_memory, search_memories, search_memories_by_entities, get_memories,
 *   get_memory, update_memory, delete_memory, delete_all_memories, list_entities.
 *
 * server-managed embeddings: searches/add send text. client-managed embeddings: the MCP embeds locally and sends the
 * precomputed vector (search → queryVector; add → queryVector+model+dim). The
 * agent-facing input is ALWAYS text — vectors are entirely internal to the MCP.
 */
import { z } from 'zod'
import { ApiError } from '../errors.ts'
import { bridgeEmbed, addVectorFields } from '../bridge.ts'
import {
  MetadataShape,
  Metadata,
  ResultRow,
  ResultRowShape,
  FactEdge,
  TimelineEntry,
  Contradiction,
  GraphProjects,
  Scope,
  ProjectField,
  SessionId,
  ok,
  toolError,
  graphResponseContractError,
  graphContradictionResponseContractError,
  fromApiError,
  projectNudge,
  RO_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  ALWAYS_LOAD_META,
} from '../schemas.ts'
import type { RegisterFn } from './context.ts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MemoryApi, MemorySurface, Runtime } from '../runtime.ts'

const SHAPE_VALUES = ['gotcha_fix', 'user_correction', 'tool_gap', 'prd', 'atomic'] as const

/** The surfaces that this particular MCP process can actually route to. */
export function configuredMemorySurfaces(runtime: Runtime): MemorySurface[] {
  if (runtime.memorySurfaces) {
    return (['personal', 'shared'] as const).filter((surface) => Boolean(runtime.memorySurfaces?.[surface]))
  }
  // A legacy single-surface runtime is still unambiguous: local installs are
  // Personal, while a server deployment is the Shared surface.
  return [runtime.deploymentMode === 'local' ? 'personal' : 'shared']
}

/**
 * Advertise only configured surfaces. Tool schemas are an agent instruction
 * surface, so offering Shared when no connector exists invites an invalid call.
 */
export function memorySurfaceField(runtime: Runtime) {
  const configured = configuredMemorySurfaces(runtime)
  if (configured.length === 1 && configured[0] === 'personal') {
    return z.literal('personal').optional().describe('Personal Memories is the only configured memory surface for this MCP.')
  }
  if (configured.length === 1 && configured[0] === 'shared') {
    return z.literal('shared').optional().describe('Shared Memories is the only configured memory surface for this MCP.')
  }
  return z
    .enum(['personal', 'shared'])
    .optional()
    .describe('Memory surface to use. Omit for the configured default; pass "shared" only when a Shared Memories connection is configured.')
}

type MemoryContext =
  | { ok: true; api: MemoryApi; runtime: Runtime; surface: MemorySurface }
  | { ok: false; error: string }

export async function selectMemoryContext(
  server: McpServer,
  api: MemoryApi,
  runtime: Runtime,
  surface?: MemorySurface,
  project?: string,
): Promise<MemoryContext> {
  const surfaces = runtime.memorySurfaces
  if (!surfaces) {
    if (runtime.deploymentMode === 'local') {
      if (surface && surface !== 'personal') {
        return { ok: false, error: 'Shared Memories is not configured for this Personal Memories MCP.' }
      }
      return { ok: true, api, runtime, surface: 'personal' }
    }
    if (surface === 'personal') {
      return {
        ok: false,
        error:
          'Personal memory is not configured for this MCP. Re-run onboarding with isolated personal memories enabled, then restart this MCP session.',
      }
    }
    return { ok: true, api, runtime, surface: 'shared' }
  }

  if (project === 'general') {
    const target = surfaces.personal
    if (!target) {
      return { ok: false, error: 'Regular chat project "general" always uses Personal Memories. Configure the Personal surface before recalling or saving general memories.' }
    }
    if (surface && surface !== 'personal') {
      return { ok: false, error: 'Regular chat project "general" always uses Personal Memories; Shared Memories cannot own general.' }
    }
    return { ok: true, api: target.api, runtime: target.runtime, surface: 'personal' }
  }

  const configured = (['personal', 'shared'] as const).filter((candidate) => Boolean(surfaces[candidate]))
  if (configured.length === 1) {
    const selected = configured[0]!
    if (surface && surface !== selected) {
      return { ok: false, error: `Memory surface "${surface}" is not configured for this MCP.` }
    }
    return { ok: true, api: surfaces[selected]!.api, runtime: surfaces[selected]!.runtime, surface: selected }
  }

  // Collection and id-based tools do not have a chat project to bind. They must
  // still honor an explicit configured surface; only task-start recall/search
  // supply "general" and therefore receive the Personal-only chat rule above.
  if (!project) {
    const selected = surface ?? surfaces.defaultSurface
    const target = surfaces[selected]
    if (!target) return { ok: false, error: `Memory surface "${selected}" is not configured for this MCP.` }
    return { ok: true, api: target.api, runtime: target.runtime, surface: selected }
  }

  const personal = surfaces.personal
  if (!personal) {
    return { ok: false, error: 'A Personal Memories connection is required to resolve a named project memory-surface binding.' }
  }

  try {
    const binding = await personal.api.get<{ project: string; surface: MemorySurface | null }>(
      `/project-memory-bindings/${encodeURIComponent(project)}`,
    )
    if (binding.surface) {
      if (surface && surface !== binding.surface) {
        return {
          ok: false,
          error: `Project "${project}" is already bound to ${binding.surface} memories. Its surface cannot be changed silently because that would split its graph history.`,
        }
      }
      return { ok: true, api: surfaces[binding.surface]!.api, runtime: surfaces[binding.surface]!.runtime, surface: binding.surface }
    }

    let chosen = surface
    if (!chosen) {
      try {
        const result = await server.server.elicitInput({
          mode: 'form',
          message: `Where should memories for project "${project}" be stored? Personal is private to you; Shared is team-visible. This choice becomes the project's graph boundary.`,
          requestedSchema: {
            type: 'object',
            properties: {
              surface: {
                type: 'string',
                title: 'Memory surface',
                oneOf: [
                  { const: 'personal', title: 'Personal Memories' },
                  { const: 'shared', title: 'Shared Memories' },
                ],
                default: 'personal',
              },
            },
            required: ['surface'],
          },
        })
        if (result.action !== 'accept' || !result.content || (result.content.surface !== 'personal' && result.content.surface !== 'shared')) {
          return { ok: false, error: `Memory surface selection for project "${project}" was cancelled. Ask the user to choose Personal or Shared Memories, then retry.` }
        }
        chosen = result.content.surface
      } catch {
        return {
          ok: false,
          error: `Project "${project}" has no memory-surface binding. Ask the user to choose Personal or Shared Memories, then retry the tool with surface:"personal" or surface:"shared".`,
        }
      }
    }

    await personal.api.post('/project-memory-bindings', { project, surface: chosen })
    return { ok: true, api: surfaces[chosen]!.api, runtime: surfaces[chosen]!.runtime, surface: chosen }
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: error.message }
    throw error
  }
}

type ResultRowValue = z.infer<typeof ResultRow>
type FactEdgeValue = z.infer<typeof FactEdge>
type TimelineEntryValue = z.infer<typeof TimelineEntry>
type ContradictionValue = z.infer<typeof Contradiction>

const RecallFact = FactEdge.extend({
  factTruncated: z.boolean().optional(),
  factBytes: z.number().int().nonnegative().optional(),
})

const RecallMemory = ResultRow.extend({
  contentTruncated: z.boolean().optional(),
  contentBytes: z.number().int().nonnegative().optional(),
})

const EntityExpansion = z.object({
  name: z.string(),
  factRefs: z.array(z.string()),
})

const RecallPlaneCounts = z.object({
  memories: z.number(),
  graphFacts: z.number(),
  entityExpansions: z.number(),
  entityFacts: z.number(),
  timelineEntries: z.number(),
  contradictions: z.number(),
  uniqueFacts: z.number(),
})

const RecallContextOutputShape = {
  schemaVersion: z.literal(2),
  query: z.string(),
  queryTruncated: z.boolean(),
  project: z.string().nullable(),
  surface: z.enum(['personal', 'shared']),
  counts: z.object({
    available: RecallPlaneCounts,
    included: RecallPlaneCounts,
    omitted: RecallPlaneCounts,
  }),
  memoryCounts: z.object({ own: z.number(), other: z.number() }),
  memories: z.array(RecallMemory),
  facts: z.record(z.string(), RecallFact),
  graph: z.object({ factRefs: z.array(z.string()) }),
  entities: z.array(EntityExpansion),
  timeline: z.object({
    centerNodeUuid: z.string().nullable(),
    entries: z.array(z.object({ factRef: z.string(), status: z.enum(['valid', 'invalid']) })),
  }),
  contradictions: z.object({
    centerNodeUuid: z.string().nullable(),
    results: z.array(z.object({ supersededRef: z.string(), supersededByRef: z.string().nullable() })),
  }),
  followup: z.object({
    memoryIds: z.array(z.string()),
    entities: z.array(z.string()),
    centerNodeUuids: z.array(z.string()),
  }),
  contextSummary: z.string(),
  budget: z.object({
    softLimitBytes: z.number().int(),
    hardLimitBytes: z.number().int(),
    resultBytes: z.number().int(),
    truncated: z.boolean(),
    memoryPreviews: z.number().int(),
    factPreviews: z.number().int(),
  }),
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

function collectEntityNames(memories: ResultRowValue[], facts: FactEdgeValue[], explicit: string[] = []): string[] {
  const fromMemories = memories.flatMap((row) => row.entities ?? [])
  const fromFacts = facts.flatMap((fact) => [fact.source_name, fact.target_name])
  return uniqueStrings([...explicit, ...fromMemories, ...fromFacts]).slice(0, 8)
}

function collectPreferredNodeUuids(facts: FactEdgeValue[], preferredEntityNames: string[]): string[] {
  const out: string[] = []
  for (const name of preferredEntityNames) {
    for (const fact of facts) {
      const uuid =
        fact.source_name === name
          ? fact.source_node_uuid
          : fact.target_name === name
            ? fact.target_node_uuid
            : null
      if (uuid && !out.includes(uuid)) {
        out.push(uuid)
        break
      }
    }
  }
  return out
}

function collectCenterNodeUuids(
  facts: FactEdgeValue[],
  entityFacts: FactEdgeValue[],
  preferredEntityNames: string[] = [],
): string[] {
  const preferred = collectPreferredNodeUuids([...facts, ...entityFacts], preferredEntityNames)
  const counts = new Map<string, number>()
  for (const fact of [...facts, ...entityFacts]) {
    for (const uuid of [fact.source_node_uuid, fact.target_node_uuid]) {
      if (!uuid) continue
      counts.set(uuid, (counts.get(uuid) ?? 0) + 1)
    }
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([uuid]) => uuid)
    .filter((uuid) => !preferred.includes(uuid))
  return [...preferred, ...ranked]
}

type RecallMemoryValue = ResultRowValue & { contentTruncated?: boolean; contentBytes?: number }
type RecallFactValue = FactEdgeValue & { factTruncated?: boolean; factBytes?: number }
type RecallPlaneCountValue = {
  memories: number
  graphFacts: number
  entityExpansions: number
  entityFacts: number
  timelineEntries: number
  contradictions: number
  uniqueFacts: number
}

const RECALL_SOFT_LIMIT_BYTES = 16 * 1024
const RECALL_HARD_LIMIT_BYTES = 24 * 1024
const MEMORY_PREVIEW_CHARS = 600
const FACT_PREVIEW_CHARS = 400

function recallSummaryLine(counts: RecallPlaneCountValue): string {
  return `Recall context: ${counts.memories} memories, ${counts.uniqueFacts} unique graph facts, ` +
    `${counts.entityExpansions} entity expansions, ${counts.timelineEntries} timeline entries, ` +
    `${counts.contradictions} contradictions.`
}

function mergeFact(existing: FactEdgeValue | undefined, incoming: FactEdgeValue): FactEdgeValue {
  if (!existing) return { ...incoming }
  const merged = { ...existing }
  for (const key of Object.keys(incoming) as Array<keyof FactEdgeValue>) {
    if ((merged[key] === null || merged[key] === undefined) && incoming[key] !== null && incoming[key] !== undefined) {
      Object.assign(merged, { [key]: incoming[key] })
    }
  }
  return merged
}

function previewText(text: string, maxChars: number, guidance: string): { text: string; truncated: boolean; bytes: number } {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (text.length <= maxChars) return { text, truncated: false, bytes: originalBytes }
  return { text: `${text.slice(0, maxChars)}… [truncated; ${guidance}]`, truncated: true, bytes: originalBytes }
}

function compactRecallSummary(input: {
  query: string
  memories: RecallMemoryValue[]
  entityNames: string[]
  counts: RecallPlaneCountValue
  truncated: boolean
}): string {
  const memoryIndex = input.memories.length ? input.memories.map((memory) => memory.id).join(', ') : 'none'
  const entityIndex = input.entityNames.length ? input.entityNames.join(', ') : 'none'
  const history = input.counts.timelineEntries || input.counts.contradictions
    ? ` Timeline includes current and superseded history (${input.counts.timelineEntries} entries, ${input.counts.contradictions} contradictions).`
    : ' No timeline or superseded history was returned.'
  const budgetNote = input.truncated ? ' Some evidence is previewed or omitted; use followup IDs for targeted retrieval.' : ''
  return `Memory evidence index for: ${input.query}\nMemories: ${memoryIndex}.\nEntities: ${entityIndex}.\n` +
    `${input.counts.uniqueFacts} unique graph facts are referenced once from the graph planes.${history}${budgetNote}`
}

export function packRecallContext(input: {
  query: string
  project: string | null
  surface: 'personal' | 'shared'
  memories: ResultRowValue[]
  memoryCounts: { own: number; other: number }
  graphFacts: FactEdgeValue[]
  entities: Array<{ name: string; facts: FactEdgeValue[] }>
  timelineCenterNodeUuid: string | null
  timeline: TimelineEntryValue[]
  contradictionCenterNodeUuid: string | null
  contradictions: ContradictionValue[]
  followupEntities: string[]
  centerNodeUuids: string[]
}): { summary: string; structured: Record<string, unknown> } {
  const allFacts = new Map<string, FactEdgeValue>()
  const factOrder: string[] = []
  const register = (fact: FactEdgeValue) => {
    if (!fact.uuid) return
    if (!allFacts.has(fact.uuid)) factOrder.push(fact.uuid)
    allFacts.set(fact.uuid, mergeFact(allFacts.get(fact.uuid), fact))
  }
  input.graphFacts.forEach(register)
  input.entities.flatMap((entity) => entity.facts).forEach(register)
  input.timeline.forEach(register)
  input.contradictions.flatMap((item) => [item.superseded, item.superseded_by].filter((fact): fact is FactEdgeValue => Boolean(fact))).forEach(register)

  const available: RecallPlaneCountValue = {
    memories: input.memories.length,
    graphFacts: input.graphFacts.length,
    entityExpansions: input.entities.length,
    entityFacts: input.entities.reduce((sum, entity) => sum + entity.facts.length, 0),
    timelineEntries: input.timeline.length,
    contradictions: input.contradictions.length,
    uniqueFacts: allFacts.size,
  }
  let memories: RecallMemoryValue[] = input.memories.map((memory) => ({ ...memory }))
  let facts = new Map<string, RecallFactValue>([...allFacts.entries()].map(([id, fact]) => [id, { ...fact }]))
  let entities = input.entities.map((entity) => ({ name: entity.name, refs: uniqueStrings(entity.facts.map((fact) => fact.uuid)) }))
  let query = input.query
  let queryTruncated = false
  let memoryPreviews = 0
  let factPreviews = 0
  let truncated = false
  const followupMemoryIds = uniqueStrings(input.memories.map((memory) => memory.id))
  const followupEntityNames = uniqueStrings(input.followupEntities)

  const graphRefOrder = uniqueStrings(input.graphFacts.map((fact) => fact.uuid))
  const timelineRefRows = input.timeline.map((entry) => ({ factRef: entry.uuid, status: entry.status }))
  const contradictionRefRows = input.contradictions.map((item) => ({
    supersededRef: item.superseded.uuid,
    supersededByRef: item.superseded_by?.uuid ?? null,
  }))

  const build = () => {
    const selectedIds = new Set(facts.keys())
    const graphRefs = graphRefOrder.filter((id) => selectedIds.has(id))
    const entityRows = entities.map((entity) => ({ name: entity.name, factRefs: entity.refs.filter((id) => selectedIds.has(id)) }))
    const timelineEntries = timelineRefRows.filter((entry) => selectedIds.has(entry.factRef))
    const contradictionResults = contradictionRefRows.filter((entry) =>
      selectedIds.has(entry.supersededRef) && (entry.supersededByRef === null || selectedIds.has(entry.supersededByRef)),
    )
    const referencedIds = new Set([
      ...graphRefs,
      ...entityRows.flatMap((entity) => entity.factRefs),
      ...timelineEntries.map((entry) => entry.factRef),
      ...contradictionResults.flatMap((entry) => [entry.supersededRef, entry.supersededByRef].filter((id): id is string => Boolean(id))),
    ])
    const factRegistry = Object.fromEntries([...facts.entries()].filter(([id]) => referencedIds.has(id)))
    const included: RecallPlaneCountValue = {
      memories: memories.length,
      graphFacts: graphRefs.length,
      entityExpansions: entityRows.length,
      entityFacts: entityRows.reduce((sum, entity) => sum + entity.factRefs.length, 0),
      timelineEntries: timelineEntries.length,
      contradictions: contradictionResults.length,
      uniqueFacts: Object.keys(factRegistry).length,
    }
    const omitted = Object.fromEntries(
      Object.entries(available).map(([key, value]) => [key, Math.max(0, value - included[key as keyof RecallPlaneCountValue])]),
    ) as RecallPlaneCountValue
    const structured = {
      schemaVersion: 2 as const,
      query,
      queryTruncated,
      project: input.project,
      surface: input.surface,
      counts: { available, included, omitted },
      memoryCounts: input.memoryCounts,
      memories,
      facts: factRegistry,
      graph: { factRefs: graphRefs },
      entities: entityRows,
      timeline: { centerNodeUuid: input.timelineCenterNodeUuid, entries: timelineEntries },
      contradictions: { centerNodeUuid: input.contradictionCenterNodeUuid, results: contradictionResults },
      followup: {
        memoryIds: followupMemoryIds,
        entities: followupEntityNames,
        centerNodeUuids: input.centerNodeUuids,
      },
      contextSummary: '',
      budget: {
        softLimitBytes: RECALL_SOFT_LIMIT_BYTES,
        hardLimitBytes: RECALL_HARD_LIMIT_BYTES,
        resultBytes: 0,
        truncated,
        memoryPreviews,
        factPreviews,
      },
    }
    structured.contextSummary = compactRecallSummary({
      query,
      memories,
      entityNames: entityRows.map((entity) => entity.name),
      counts: included,
      truncated,
    })
    const summary = recallSummaryLine(included)
    for (let pass = 0; pass < 4; pass += 1) {
      const nextBytes = Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: summary }], structuredContent: structured }), 'utf8')
      if (nextBytes === structured.budget.resultBytes) break
      structured.budget.resultBytes = nextBytes
    }
    return { summary, structured }
  }

  let packed = build()
  if (packed.structured.budget.resultBytes > RECALL_SOFT_LIMIT_BYTES) {
    truncated = true
    memories = memories.map((memory) => {
      const preview = previewText(memory.content, MEMORY_PREVIEW_CHARS, `use get_memory ${memory.id}`)
      if (!preview.truncated) return memory
      memoryPreviews += 1
      return { ...memory, content: preview.text, contentTruncated: true, contentBytes: preview.bytes }
    })
    facts = new Map([...facts.entries()].map(([id, fact]) => {
      if (!fact.fact) return [id, fact]
      const preview = previewText(fact.fact, FACT_PREVIEW_CHARS, `fact ${id}`)
      if (!preview.truncated) return [id, fact]
      factPreviews += 1
      return [id, { ...fact, fact: preview.text, factTruncated: true, factBytes: preview.bytes }]
    }))
    packed = build()
  }

  const protectedRefs = new Set([
    ...graphRefOrder,
    ...timelineRefRows.map((entry) => entry.factRef),
    ...contradictionRefRows.flatMap((entry) => [entry.supersededRef, entry.supersededByRef].filter((id): id is string => Boolean(id))),
  ])
  for (const id of [...factOrder].reverse()) {
    if (packed.structured.budget.resultBytes <= RECALL_SOFT_LIMIT_BYTES) break
    if (protectedRefs.has(id)) continue
    facts.delete(id)
    packed = build()
  }
  for (const id of [...factOrder].reverse()) {
    if (packed.structured.budget.resultBytes <= RECALL_SOFT_LIMIT_BYTES || facts.size <= 4) break
    facts.delete(id)
    packed = build()
  }
  while (packed.structured.budget.resultBytes > RECALL_SOFT_LIMIT_BYTES && memories.length > 3) {
    memories = memories.slice(0, -1)
    packed = build()
  }
  while (packed.structured.budget.resultBytes > RECALL_SOFT_LIMIT_BYTES && entities.length > 4) {
    entities = entities.slice(0, -1)
    packed = build()
  }
  while (packed.structured.budget.resultBytes > RECALL_HARD_LIMIT_BYTES && facts.size > 1) {
    const last = [...facts.keys()].at(-1)
    if (last) facts.delete(last)
    packed = build()
  }
  while (packed.structured.budget.resultBytes > RECALL_HARD_LIMIT_BYTES && memories.length > 1) {
    memories = memories.slice(0, -1)
    packed = build()
  }
  if (packed.structured.budget.resultBytes > RECALL_HARD_LIMIT_BYTES && query.length > 512) {
    query = `${query.slice(0, 512)}… [truncated]`
    queryTruncated = true
    packed = build()
  }
  if (packed.structured.budget.resultBytes > RECALL_HARD_LIMIT_BYTES) {
    throw new Error(`recall_context could not satisfy the ${RECALL_HARD_LIMIT_BYTES}-byte hard response budget`)
  }
  return packed
}

export const registerMemoryTools: RegisterFn = (server, { api, runtime }) => {
  const MemorySurfaceField = memorySurfaceField(runtime)
  // ── recall_context (graph-first mandatory recall) ───────────────────────────
  server.registerTool(
    'recall_context',
    {
      title: 'Recall memory context',
      description:
        'MANDATORY first call for non-trivial tasks. Retrieves the graph-first memory picture: closest ' +
        'semantic memories, connected graph facts, entity expansions, timeline entries, and contradictions. ' +
        'Use this before planning, editing, reviewing, debugging, or answering project/process questions. ' +
        'If the client deferred the persistent-memory tools, load this tool first via ToolSearch/tool_search.',
      inputSchema: {
        surface: MemorySurfaceField,
        query: z.string().min(1).describe('Natural-language task/question. e.g. "how does auth routing work now"'),
        project: z.string().min(1).optional().describe('Restrict to one project/repo. e.g. "persistent-memory"'),
        projects: GraphProjects,
        entityNames: z
          .array(z.string().min(1))
          .default([])
          .describe('Optional known entities to expand immediately. e.g. ["component_AuthGuard"]'),
        memoryLimit: z.number().int().min(1).max(20).default(5).describe('Closest memories to include. e.g. 5'),
        graphLimit: z.number().int().min(1).max(50).default(10).describe('Graph facts to search. e.g. 10'),
        entityLimit: z.number().int().min(1).max(30).default(10).describe('Facts per entity expansion. e.g. 10'),
        timelineLimit: z.number().int().min(0).max(100).default(20).describe('Timeline entries for the most connected node. 0 disables timeline.'),
        includeInvalid: z.boolean().default(true).describe('Include invalid/superseded timeline facts. e.g. true'),
        validOnly: z.boolean().default(false).describe('Graph search only currently-valid facts. Default false so contradictions remain visible.'),
        scope: Scope,
      },
      outputSchema: RecallContextOutputShape,
      annotations: RO_ANNOTATIONS,
      _meta: ALWAYS_LOAD_META,
    },
    async (input) => {
      const projects = input.projects ?? [input.project ?? 'general']
      const projectContexts = await Promise.all(projects.map(async (project) => ({ project, ctx: await selectMemoryContext(server, api, runtime, input.surface, project) })))
      const contextFailure = projectContexts.find((entry) => !entry.ctx.ok)
      if (contextFailure && !contextFailure.ctx.ok) return toolError(contextFailure.ctx.error)
      const resolvedContexts = projectContexts.filter((entry): entry is { project: string; ctx: Extract<MemoryContext, { ok: true }> } => entry.ctx.ok)
      const ctx = resolvedContexts[0]!.ctx

      const memoryLimit = input.memoryLimit ?? 5
      const graphLimit = input.graphLimit ?? 10
      const entityLimit = input.entityLimit ?? 10
      const timelineLimit = input.timelineLimit ?? 20
      const includeInvalid = input.includeInvalid ?? true
      const validOnly = input.validOnly ?? false

      const memoryBody: Record<string, unknown> = { limit: memoryLimit }

      try {
        const memoryResults = await Promise.all(resolvedContexts.map(async ({ project, ctx: projectCtx }) => {
          const body: Record<string, unknown> = { ...memoryBody, project }
          if (projectCtx.runtime.mode === 'client-bridge') {
            const r = await bridgeEmbed(projectCtx.runtime, input.query, 'query')
            if (!r.ok || !r.vector) throw new Error(r.ok ? 'Local embedding produced no vector for the recall query.' : r.error)
            body.queryVector = r.vector
          } else body.query = input.query
          return projectCtx.api.post<{ results: ResultRowValue[]; counts: { own: number; other: number } }>('/memories/search', body)
        }))
        const memoryRes = {
          results: memoryResults.flatMap((result) => result.results),
          counts: memoryResults.reduce((counts, result) => ({
            own: counts.own + result.counts.own,
            other: counts.other + result.counts.other,
          }), { own: 0, other: 0 }),
        }
        const graphResults = await Promise.all(resolvedContexts.map(({ project, ctx: projectCtx }) => projectCtx.api.post<{ facts: FactEdgeValue[] }>('/graph/search', {
          query: input.query, limit: graphLimit, validOnly, ...(input.scope ? { scope: input.scope } : {}), projects: [project],
        })))
        const graphRes = { facts: graphResults.flatMap((result) => result.facts) }
        const graphContractError = graphResponseContractError('recall_context', graphRes.facts)
        if (graphContractError) return graphContractError

        const entityNames = collectEntityNames(memoryRes.results, graphRes.facts, input.entityNames ?? [])
        const entityExpansions = (await Promise.all(
          entityNames.slice(0, 8).map(async (name) => {
            const results = await Promise.all(resolvedContexts.map(({ project, ctx: projectCtx }) => projectCtx.api.get<{ name: string; facts: FactEdgeValue[] }>(
              `/graph/entity/${encodeURIComponent(name)}`,
              { limit: entityLimit, scope: input.scope, projects: [project] },
            )))
            return { name, facts: results.flatMap((result) => result.facts) }
          }),
        ))
        const entityFacts = entityExpansions.flatMap((entry) => entry.facts)
        const entityContractError = graphResponseContractError('recall_context', entityFacts)
        if (entityContractError) return entityContractError
        const centerNodeUuids = collectCenterNodeUuids(graphRes.facts, entityFacts, input.entityNames ?? [])
        const centerNodeUuid = centerNodeUuids[0] ?? null

        let timelineEntries: TimelineEntryValue[] = []
        let contradictions: ContradictionValue[] = []
        if (centerNodeUuid && timelineLimit > 0) {
          const timelines = await Promise.all(resolvedContexts.map(({ project, ctx: projectCtx }) => projectCtx.api.get<{ entityUuid: string | null; entries: TimelineEntryValue[] }>('/graph/timeline', {
            entityUuid: centerNodeUuid, includeInvalid, limit: timelineLimit, scope: input.scope, projects: [project],
          })))
          timelineEntries = timelines.flatMap((timeline) => timeline.entries)
          const contradictionResults = await Promise.all(resolvedContexts.map(({ project, ctx: projectCtx }) => projectCtx.api.get<{ contradictions: ContradictionValue[] }>('/graph/contradictions', {
            entityUuid: centerNodeUuid, limit: timelineLimit, scope: input.scope, projects: [project],
          })))
          contradictions = contradictionResults.flatMap((result) => result.contradictions)
        }
        const timelineContractError = graphResponseContractError('recall_context', timelineEntries)
        if (timelineContractError) return timelineContractError
        const contradictionContractError = graphContradictionResponseContractError('recall_context', contradictions)
        if (contradictionContractError) return contradictionContractError

        const packed = packRecallContext({
          query: input.query,
          project: input.projects ? null : input.project ?? 'general',
          surface: ctx.surface,
          memories: memoryRes.results,
          memoryCounts: memoryRes.counts,
          graphFacts: graphRes.facts,
          entities: entityExpansions,
          timelineCenterNodeUuid: centerNodeUuid,
          timeline: timelineEntries,
          contradictionCenterNodeUuid: centerNodeUuid,
          contradictions,
          followupEntities: entityNames,
          centerNodeUuids,
        })
        return ok(packed.summary, packed.structured)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── add_memory ───────────────────────────────────────────────────────────────
  server.registerTool(
    'add_memory',
    {
      title: 'Add a team memory',
      description:
        'Store a validated team-scoped memory. team/user/role are derived from your token — never ' +
        'passed. `project` is REQUIRED (name the repo/project, or "general"). content+metadata pass a ' +
        'server Shape A–E gate; a 422 returns rewrite_templates + entity_format so you can self-correct ' +
        '(do NOT resend the same payload). Returns the new id, derived shape, and embeddingStatus.',
      inputSchema: {
        surface: MemorySurfaceField,
        content: z
          .string()
          .min(40)
          .describe(
            'The memory text (>=40 chars). Must match exactly one Shape A–E and contain a verbatim ' +
              'type-prefixed entity that also appears in metadata.entities. e.g. "[component_AuthGuard] ' +
              'the data plane rejects a team-less caller with 403 no_team. Root cause: the MCP requires ' +
              'team membership. Fix: assign the user to a team."',
          ),
        project: ProjectField,
        sessionId: SessionId,
        metadata: Metadata.describe('Memory metadata (category/entities/source + optional scope fields).'),
      },
      outputSchema: {
        id: z.string(),
        shape: z.string(),
        category: z.string(),
        project: z.string(),
        restructured: z.boolean(),
        content: z.string(),
        embeddingStatus: z.enum(['pending', 'embedded']),
        // Phase 9: server-assigned provenance so the agent knows how its write will be
        // trusted/ranked with provenance × confidence.
        memoryTier: z.string(),
        sourceProvenance: z.string(),
        confidence: z.number(),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      if (!input.project?.trim()) return projectNudge('add_memory')
      const ctx = await selectMemoryContext(server, api, runtime, input.surface, input.project)
      if (!ctx.ok) return toolError(ctx.error)
      // client-managed embeddings: embed the content locally (document kind) and attach the pinned vector.
      let extra: Record<string, unknown> = {}
      if (ctx.runtime.mode === 'client-bridge') {
        const r = await bridgeEmbed(ctx.runtime, input.content, 'document')
        if (!r.ok) return toolError(r.error)
        if (r.vector) extra = addVectorFields(ctx.runtime, r.vector)
      }
      try {
        const res = await ctx.api.post<{
          id: string
          shape: string
          category: string
          project: string
          restructured: boolean
          content: string
          embeddingStatus: 'pending' | 'embedded'
          memoryTier: string
          sourceProvenance: string
          confidence: number
        }>('/memories', { content: input.content, project: input.project, sessionId: input.sessionId, metadata: input.metadata, ...extra })
        // Low-confidence guidance: an agent-inferred / low-confidence memory remains
        // provisional and down-ranked. It is never automatically archived.
        const lowConf = res.confidence < 0.6 || res.sourceProvenance === 'agent_inferred'
        const guidance = lowConf
          ? ` Stored PROVISIONAL (confidence ${res.confidence.toFixed(2)}, ${res.sourceProvenance}): retrieval weights it below stronger provenance and confidence. Add corroborating detail when the fact needs more support.`
          : ''
        return ok(
          `Stored memory ${res.id} (shape=${res.shape}, category=${res.category}, project=${res.project}, ` +
            `tier=${res.memoryTier}, embedding=${res.embeddingStatus}${res.restructured ? ', restructured' : ''}).${guidance}`,
          res as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── search_memories (semantic, cross-team merge) ──────────────────────────────
  server.registerTool(
    'search_memories',
    {
      title: 'Search memories (semantic)',
      description:
        'Semantic search over your team ∪ MOUNTED teams. Results are own-team-FIRST: ' +
        '`isOwnTeam:true` = a PRIMARY memory (your current team, authoritative); `isOwnTeam:false` ' +
        '= an ADDITIONAL memory from a mounted team (context only). `counts` splits {own, other}. ' +
        'Each row carries sourceTeam + score plus the P9 TRUST fields (memoryTier, sourceProvenance, ' +
        'confidence) — weigh lower-confidence memories accordingly. Low-level semantic ' +
        'search only; for task-start recall use recall_context so graph relations and timelines are included. ' +
        'Input is always natural-language text — server-managed/client-managed embeddings vector handling is internal to the MCP.',
      inputSchema: {
        surface: MemorySurfaceField,
        query: z
          .string()
          .min(1)
          .describe('Natural-language search text. e.g. "why was a cross-team write rejected"'),
        project: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to one project. e.g. "persistent-memory"'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results. e.g. 20'),
      },
      outputSchema: {
        results: z.array(ResultRow),
        counts: z.object({ own: z.number(), other: z.number() }),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      const ctx = await selectMemoryContext(server, api, runtime, input.surface, input.project ?? 'general')
      if (!ctx.ok) return toolError(ctx.error)
      const body: Record<string, unknown> = { limit: input.limit }
      if (input.project) body.project = input.project
      if (ctx.runtime.mode === 'client-bridge') {
        const r = await bridgeEmbed(ctx.runtime, input.query, 'query')
        if (!r.ok) return toolError(r.error)
        if (!r.vector) return toolError('Local embedding produced no vector for the query (client-managed embeddings).')
        body.queryVector = r.vector
      } else {
        body.query = input.query
      }
      try {
        const res = await ctx.api.post<{ results: unknown[]; counts: { own: number; other: number } }>(
          '/memories/search',
          body,
        )
        return ok(
          `${res.results.length} result(s) — ${res.counts.own} primary (your team), ` +
            `${res.counts.other} additional (other teams). Primary memories are listed first.`,
          res as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── search_memories_by_entities (exact match; no embedding) ───────────────────
  server.registerTool(
    'search_memories_by_entities',
    {
      title: 'Search memories by entity',
      description:
        'Exact-match memories by entity name (no embedding). Use when you know the entity (e.g. a ' +
        'component or page id) and want every memory touching it. Pair with search_memories per the ' +
        'vector → graph → targeted recall pattern.',
      inputSchema: {
        surface: MemorySurfaceField,
        entities: z
          .array(z.string())
          .min(1)
          .describe('Entity names to match (exact). e.g. ["component_AuthGuard","perm_read_write"]'),
        mode: z
          .enum(['any', 'all'])
          .default('any')
          .describe('"any" = at least one entity present; "all" = every entity present. e.g. "all"'),
        project: z.string().min(1).optional().describe('Restrict to one project.'),
        limit: z.number().int().min(1).max(100).default(50).describe('Max results. e.g. 50'),
      },
      outputSchema: { results: z.array(ResultRow) },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      const ctx = await selectMemoryContext(server, api, runtime, input.surface, input.project)
      if (!ctx.ok) return toolError(ctx.error)
      try {
        const res = await ctx.api.post<{ results: unknown[] }>('/memories/search-by-entities', {
          entities: input.entities,
          mode: input.mode,
          ...(input.project ? { project: input.project } : {}),
          limit: input.limit,
        })
        return ok(`${res.results.length} memory(ies) matched entities [${input.entities.join(', ')}].`, res as unknown as Record<string, unknown>)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_memories (list, keyset paginated) ─────────────────────────────────────
  server.registerTool(
    'get_memories',
    {
      title: 'Browse memories (paginated)',
      description:
        'Browse memories with filters (project/category/shape/session), newest first, KEYSET-paginated. ' +
        'Use to enumerate rather than semantic-search. Loop on nextCursor (pass it as `cursor`) until ' +
        'nextCursor is null.',
      inputSchema: {
        surface: MemorySurfaceField,
        project: z.string().optional().describe('Filter by project.'),
        category: z.string().optional().describe('Filter by category (free-form).'),
        sessionId: z.string().optional().describe('Filter by session id.'),
        shape: z
          .enum(SHAPE_VALUES)
          .optional()
          .describe('Filter by derived shape. e.g. "gotcha_fix"'),
        cursor: z
          .string()
          .uuid()
          .optional()
          .describe('Pass the nextCursor from the previous page (keyset, not an offset).'),
        limit: z.coerce.number().int().min(1).max(100).default(50).describe('Page size. e.g. 50'),
      },
      outputSchema: {
        results: z.array(ResultRow),
        nextCursor: z.string().nullable(),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      const ctx = await selectMemoryContext(server, api, runtime, input.surface, input.project)
      if (!ctx.ok) return toolError(ctx.error)
      try {
        const res = await ctx.api.get<{ results: unknown[]; nextCursor: string | null }>('/memories', {
          project: input.project,
          category: input.category,
          sessionId: input.sessionId,
          shape: input.shape,
          cursor: input.cursor,
          limit: input.limit,
        })
        return ok(
          `${res.results.length} memory(ies)${res.nextCursor ? ' (more: pass nextCursor as cursor)' : ' (last page)'}.`,
          res as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── get_memory ────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_memory',
    {
      title: 'Get one memory',
      description:
        'Fetch one memory by id (readable scope). An unreadable/absent id → a not_found error (a ' +
        'cross-team item you lack a grant for is indistinguishable from missing).',
      inputSchema: { surface: MemorySurfaceField, id: z.string().uuid().describe('Memory id. e.g. "3f5b…"') },
      outputSchema: ResultRowShape,
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      const ctx = await selectMemoryContext(server, api, runtime, input.surface)
      if (!ctx.ok) return toolError(ctx.error)
      try {
        const res = await ctx.api.get<Record<string, unknown>>(`/memories/${input.id}`)
        return ok(`Memory ${input.id} (project=${String(res.project)}, category=${String(res.category)}).`, res)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── update_memory ──────────────────────────────────────────────────────────────
  server.registerTool(
    'update_memory',
    {
      title: 'Update a memory',
      description:
        'Edit a memory you own (own team only). Pass at least one mutable field. Changing content or ' +
        'metadata re-runs the Shape gate (a 422 returns rewrite_templates). `project` is optional here ' +
        '(you are editing an already-classified memory) but if passed must be non-empty.',
      inputSchema: {
        surface: MemorySurfaceField,
        id: z.string().uuid().describe('Memory id from add_memory/search_memories. e.g. "3f5b…"'),
        content: z
          .string()
          .min(40)
          .optional()
          .describe('New memory text (>=40 chars; re-validated against the Shape gate).'),
        project: z
          .string()
          .min(1)
          .optional()
          .describe('New project tag (optional; must be non-empty if present). e.g. "persistent-memory"'),
        sessionId: z.string().optional().describe('New session id.'),
        metadata: Metadata.optional().describe('New metadata (re-validated).'),
      },
      outputSchema: { ...ResultRowShape, restructured: z.boolean() },
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      const hasMutable =
        input.content !== undefined ||
        input.project !== undefined ||
        input.sessionId !== undefined ||
        input.metadata !== undefined
      if (!hasMutable) {
        return toolError('Nothing to update — pass at least one of content/project/sessionId/metadata.')
      }
      const ctx = await selectMemoryContext(server, api, runtime, input.surface)
      if (!ctx.ok) return toolError(ctx.error)
      const body: Record<string, unknown> = {}
      if (input.content !== undefined) body.content = input.content
      if (input.project !== undefined) body.project = input.project
      if (input.sessionId !== undefined) body.sessionId = input.sessionId
      if (input.metadata !== undefined) body.metadata = input.metadata
      try {
        const res = await ctx.api.patch<Record<string, unknown>>(`/memories/${input.id}`, body)
        return ok(
          `Updated memory ${input.id}${res.restructured ? ' (restructured by the Shape gate)' : ''}.`,
          res,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── delete_memory ──────────────────────────────────────────────────────────────
  server.registerTool(
    'delete_memory',
    {
      title: 'Delete one memory',
      description:
        'Permanently delete ONE memory you own (OWN TEAM ONLY — RLS blocks cross-team deletes even ' +
        'with a read grant). Removes the row and its vector. A not_found error means the id is absent ' +
        'or not yours.',
      inputSchema: { surface: MemorySurfaceField, id: z.string().uuid().describe('Memory id to delete. e.g. "3f5b…"') },
      outputSchema: { deleted: z.literal(true), id: z.string() },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (input) => {
      const ctx = await selectMemoryContext(server, api, runtime, input.surface)
      if (!ctx.ok) return toolError(ctx.error)
      try {
        // The API returns 204 No Content; normalize to {deleted:true, id}.
        await ctx.api.delNoContent(`/memories/${input.id}`)
        return ok(`Deleted memory ${input.id}.`, { deleted: true, id: input.id })
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── delete_all_memories ──────────────────────────────────────────────────────
  server.registerTool(
    'delete_all_memories',
    {
      title: 'Bulk-delete memories',
      description:
        'Bulk-delete memories in your CURRENT team (optionally one project). A plain member deletes ' +
        'only their OWN-created memories; a team-admin/super-admin deletes any author in the team. ' +
        'Never crosses teams (RLS backstops it). Requires confirm:true. Irreversible — prefer a ' +
        'project-scoped delete. Omitting project means "all (eligible) memories in your team".',
      inputSchema: {
        surface: MemorySurfaceField,
        project: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict the bulk delete to one project; omit to delete ALL eligible team memories. e.g. "scratch-experiment"'),
        confirm: z
          .literal(true)
          .describe('Must be exactly true. Guards against accidental mass deletion.'),
      },
      outputSchema: { deleted: z.number() },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (input) => {
      const ctx = await selectMemoryContext(server, api, runtime, input.surface, input.project)
      if (!ctx.ok) return toolError(ctx.error)
      try {
        const res = await ctx.api.del<{ deleted: number }>('/memories', {
          ...(input.project ? { project: input.project } : {}),
          confirm: true,
        })
        return ok(
          `Deleted ${res.deleted} memory(ies)${input.project ? ` in project "${input.project}"` : ' (all your team memories)'}.`,
          res as unknown as Record<string, unknown>,
        )
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )

  // ── list_entities ──────────────────────────────────────────────────────────────
  server.registerTool(
    'list_entities',
    {
      title: 'List entity names',
      description:
        'List distinct entity names across your readable memories with occurrence counts (own-team ' +
        'names first). Use to discover what entities exist before search_memories_by_entities.',
      inputSchema: {
        surface: MemorySurfaceField,
        project: z.string().optional().describe('Restrict to one project.'),
        limit: z.coerce.number().int().min(1).max(2000).default(500).describe('Max entities. e.g. 500'),
      },
      outputSchema: {
        entities: z.array(z.object({ name: z.string(), count: z.number() })),
      },
      annotations: RO_ANNOTATIONS,
    },
    async (input) => {
      const ctx = await selectMemoryContext(server, api, runtime, input.surface, input.project)
      if (!ctx.ok) return toolError(ctx.error)
      try {
        const res = await ctx.api.get<{ entities: { name: string; count: number }[] }>('/entities', {
          project: input.project,
          limit: input.limit,
        })
        return ok(`${res.entities.length} distinct entity(ies).`, res as unknown as Record<string, unknown>)
      } catch (e) {
        if (e instanceof ApiError) return fromApiError(e)
        throw e
      }
    },
  )
}
