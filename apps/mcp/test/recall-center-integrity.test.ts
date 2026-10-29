import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { packRecallContext, registerAllTools } from '../src/server.ts'
import type { Runtime } from '../src/runtime.ts'

type Input = Parameters<typeof packRecallContext>[0]
type Fact = Input['graphFacts'][number]
type Reply = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
type Context = {
  facts: Record<string, Fact>
  graph: { factRefs: string[] }
  entities: { factRefs: string[] }[]
  timeline: { centerNodeUuid: string | null; entries: { factRef: string; status: string }[] }
  contradictions: { centerNodeUuid: string | null; results: { supersededRef: string; supersededByRef: string | null }[] }
  budget: { softLimitBytes: number; hardLimitBytes: number; resultBytes: number; truncated: boolean }
}
const runtime: Runtime = { mode: 'server', deploymentMode: 'local', pin: { modelId: 'test', dim: 3 }, bridge: null }
const fact = (id: string, extra: Partial<Fact> = {}): Fact => ({
  uuid: id, name: 'RELATES_TO', fact: `Evidence ${id}`,
  source_node_uuid: `source-${id}`, target_node_uuid: `target-${id}`,
  source_name: `component_source_${id}`, target_name: `component_target_${id}`,
  group_id: 'owner-team', project: 'test-project', surface: 'personal', relation: 'own',
  episodes: [`episode-${id}`], sourceMemoryIds: ['memory-source'],
  assertionStatus: 'observation', verification: 'derived_source_reported',
  valid_at: '2026-10-28T00:00:00Z', invalid_at: null, ...extra,
})
const input = (extra: Partial<Input> = {}): Input => ({
  query: 'Recall center integrity', project: 'test-project', surface: 'personal',
  memories: [], memoryCounts: { own: 0, other: 0 }, graphFacts: [], entities: [],
  timelineCenterNodeUuid: null, timeline: [], contradictionCenterNodeUuid: null, contradictions: [],
  followupEntities: [], centerNodeUuids: [], ...extra,
})
let validate: ReturnType<AjvJsonSchemaValidator['getValidator']>
beforeAll(async () => {
  const server = new McpServer({ name: 'center-contract', version: '1.0.0' })
  registerAllTools(server, { api: {}, runtime } as never)
  const client = new Client({ name: 'center-contract', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tool = (await client.listTools()).tools.find(row => row.name === 'recall_context')!
    validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)
  } finally {
    await client.close()
    await server.close()
  }
})
function assertReply(reply: Reply): Context {
  expect(reply.isError).not.toBe(true)
  const validation = validate(reply.structuredContent)
  expect(validation.valid, validation.errorMessage).toBe(true)
  const context = reply.structuredContent as unknown as Context
  const endpoints = new Set(Object.values(context.facts).flatMap(row => [row.source_node_uuid, row.target_node_uuid]).filter(Boolean))
  for (const plane of [context.timeline, context.contradictions]) {
    if (plane.centerNodeUuid !== null) expect(endpoints.has(plane.centerNodeUuid)).toBe(true)
  }
  const refs = [
    ...context.graph.factRefs, ...context.entities.flatMap(row => row.factRefs),
    ...context.timeline.entries.map(row => row.factRef),
    ...context.contradictions.results.flatMap(row => [row.supersededRef, row.supersededByRef].filter((id): id is string => id !== null)),
  ]
  for (const id of refs) expect(context.facts).toHaveProperty(id)
  for (const row of Object.values(context.facts)) expect(row).not.toHaveProperty('status')
  expect(context.budget.softLimitBytes).toBe(16 * 1024)
  expect(context.budget.hardLimitBytes).toBe(24 * 1024)
  expect(context.budget.resultBytes).toBe(Buffer.byteLength(JSON.stringify(reply), 'utf8'))
  expect(context.budget.resultBytes).toBeLessThanOrEqual(context.budget.hardLimitBytes)
  return context
}
const pack = (value: Input) => {
  const result = packRecallContext(value)
  return { content: [{ type: 'text' as const, text: result.summary }], structuredContent: result.structured }
}

describe('recall final-registry center integrity', () => {
  it.each([
    ['source-0', 'target-1'],
    ['missing-timeline', 'target-1'],
    ['source-0', 'missing-conflict'],
    [null, null],
  ])('preserves each original plane center only when witnessed: %s / %s', (timelineCenter, conflictCenter) => {
    const first = fact('0', { invalid_at: '2026-10-28T01:00:00Z' })
    const second = fact('1')
    const args = input({
      graphFacts: [first], timelineCenterNodeUuid: timelineCenter,
      contradictionCenterNodeUuid: conflictCenter,
      timeline: [{ ...first, status: 'invalid' }, { ...second, status: 'valid' }],
      contradictions: [{ superseded: first, superseded_by: second }],
    })
    const original = structuredClone(args)
    const context = assertReply(pack(args))
    expect(context.timeline.centerNodeUuid).toBe(timelineCenter === 'source-0' ? timelineCenter : null)
    expect(context.contradictions.centerNodeUuid).toBe(conflictCenter === 'target-1' ? conflictCenter : null)
    expect(context.facts).toEqual({ '0': first, '1': second })
    expect(context.timeline.entries).toEqual([{ factRef: '0', status: 'invalid' }, { factRef: '1', status: 'valid' }])
    expect(context.contradictions.results).toEqual([{ supersededRef: '0', supersededByRef: '1' }])
    expect(args).toEqual(original)
  })

  it('nulls both hints for an empty final registry without substituting another center', () => {
    const context = assertReply(pack(input({ timelineCenterNodeUuid: 'old-timeline', contradictionCenterNodeUuid: 'old-conflict', centerNodeUuids: ['old-timeline', 'old-conflict'] })))
    expect(context.facts).toEqual({})
    expect(context.timeline.centerNodeUuid).toBeNull()
    expect(context.contradictions.centerNodeUuid).toBeNull()
  })

  it('recomputes witnesses after soft-budget fact pruning and preserves surviving references', () => {
    const facts = Array.from({ length: 40 }, (_, i) => fact(String(i), { fact: 'Long evidence '.repeat(100) }))
    const context = assertReply(pack(input({
      graphFacts: facts, timelineCenterNodeUuid: facts.at(-1)!.source_node_uuid,
      contradictionCenterNodeUuid: facts[0]!.target_node_uuid,
      timeline: [{ ...facts[0]!, status: 'invalid' }, { ...facts[1]!, status: 'valid' }, { ...facts.at(-1)!, status: 'valid' }],
      contradictions: [{ superseded: facts[0]!, superseded_by: facts[1]! }],
    })))
    expect(context.budget.truncated).toBe(true)
    expect(context.budget.resultBytes).toBeLessThanOrEqual(context.budget.softLimitBytes)
    expect(Object.keys(context.facts).length).toBeLessThan(facts.length)
    expect(context.facts).not.toHaveProperty('39')
    expect(context.timeline.centerNodeUuid).toBeNull()
    expect(context.contradictions.centerNodeUuid).toBe(facts[0]!.target_node_uuid)
    expect(context.timeline.entries).toEqual([{ factRef: '0', status: 'invalid' }, { factRef: '1', status: 'valid' }])
    expect(context.contradictions.results).toEqual([{ supersededRef: '0', supersededByRef: '1' }])
  })

  it('recomputes witnesses after hard-budget pruning beyond the four-fact soft floor', () => {
    // Names are deliberately large: fact previews alone cannot fit this input.
    const facts = [fact('0'), fact('1', { source_name: 'x'.repeat(14000) }), fact('2', { source_name: 'y'.repeat(14000) }), fact('3')]
    const context = assertReply(pack(input({
      graphFacts: facts, timelineCenterNodeUuid: 'source-3', contradictionCenterNodeUuid: 'target-0',
      timeline: [{ ...facts[0]!, status: 'invalid' }, { ...facts[3]!, status: 'valid' }],
      contradictions: [{ superseded: facts[0]!, superseded_by: facts[1]! }],
    })))
    expect(Object.keys(context.facts)).toEqual(['0', '1'])
    expect(context.budget.resultBytes).toBeGreaterThan(context.budget.softLimitBytes)
    expect(context.timeline.centerNodeUuid).toBeNull()
    expect(context.contradictions.centerNodeUuid).toBe('target-0')
    expect(context.timeline.entries).toEqual([{ factRef: '0', status: 'invalid' }])
    expect(context.contradictions.results).toEqual([{ supersededRef: '0', supersededByRef: '1' }])
  })

  it.each([false, true])('validates an untouched registered-handler reply with a pruned witness: %s', async prune => {
    const witness = fact('witness', { source_name: 'component_center' })
    const facts = Array.from({ length: prune ? 40 : 1 }, (_, i) => fact(String(i), { fact: 'Long evidence '.repeat(prune ? 100 : 1) }))
    const api = {
      post: vi.fn(async (path: string) => path === '/memories/search'
        ? { results: [], counts: { own: 0, other: 0 } }
        : { facts }),
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/graph/entity/')) return { facts: [witness] }
        if (path === '/graph/timeline') return { entries: [] }
        if (path === '/graph/contradictions') return { contradictions: [] }
        throw new Error(`Unexpected ${path}`)
      }),
    }
    let handler: ((value: Record<string, unknown>) => Promise<Reply>) | undefined
    registerAllTools({ registerTool(name: string, options: { inputSchema?: z.ZodRawShape }, fn: typeof handler) {
      if (name === 'recall_context') handler = value => fn!(z.object(options.inputSchema!).parse(value))
    } } as never, { api, runtime } as never)
    const reply = await handler!({ query: 'Find the selected entity center', entityNames: ['component_center'] })
    const context = assertReply(reply)
    const expected = prune ? null : witness.source_node_uuid
    expect(context.timeline.centerNodeUuid).toBe(expected)
    expect(context.contradictions.centerNodeUuid).toBe(expected)
    expect(Object.hasOwn(context.facts, witness.uuid)).toBe(!prune)
    expect(api.get).toHaveBeenCalledWith('/graph/timeline', expect.objectContaining({ entityUuid: witness.source_node_uuid }))
    // Schema validity does not imply semantic validity: the old defect passes JSON Schema.
    const invalid = structuredClone(reply)
    ;(invalid.structuredContent!.timeline as Context['timeline']).centerNodeUuid = 'unwitnessed-center'
    expect(validate(invalid.structuredContent).valid).toBe(true)
    expect(() => assertReply(invalid)).toThrow()
  })
})
