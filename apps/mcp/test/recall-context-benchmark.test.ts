import { afterAll, describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { registerAllTools } from '../src/server.ts'
import type { Runtime } from '../src/runtime.ts'
import { measureRecallResult, type RecallMeasurement } from './recall-context-metrics.ts'

type ToolOptions = {
  description?: string
  inputSchema?: z.ZodRawShape
  outputSchema?: z.ZodRawShape
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}
type Tool = {
  options: ToolOptions
  handler: (input: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }>
}

function collectAllTools(api: unknown, runtime: Runtime): Map<string, Tool> {
  const tools = new Map<string, Tool>()
  const server = {
    registerTool(name: string, options: ToolOptions, handler: Tool['handler']) {
      tools.set(name, { options, handler })
    },
  }
  registerAllTools(server as never, { api, runtime } as never)
  return tools
}

const runtime: Runtime = {
  mode: 'server',
  deploymentMode: 'local',
  pin: { modelId: 'qwen3-embedding:4b', dim: 2560 },
  bridge: null,
}

const demoProject = 'demo_project'
const otherProject = 'other_project'
const team = 'team-memory-benchmark'

function memoryRow(
  id: string,
  content: string,
  entities: string[],
  rowProject = demoProject,
  score = 0.95,
) {
  return {
    id,
    content,
    category: 'benchmark',
    shape: 'atomic',
    entities,
    project: rowProject,
    sessionId: null,
    createdById: 'benchmark-user',
    score,
    sourceTeam: team,
    isOwnTeam: true,
    createdAt: '2026-08-05T10:00:00.000Z',
    recordUpdatedAt: '2026-08-05T10:00:00.000Z',
    memoryTier: 'semantic',
    sourceProvenance: 'human_verified',
    confidence: 0.98,
  }
}

function nodeId(entity: string): string {
  return `node-${entity.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function fact(
  uuid: string,
  name: string,
  sourceName: string,
  targetName: string,
  factText: string,
  validAt: string,
  invalidAt: string | null = null,
) {
  return {
    uuid,
    name,
    fact: factText,
    source_node_uuid: nodeId(sourceName),
    target_node_uuid: nodeId(targetName),
    source_name: sourceName,
    target_name: targetName,
    group_id: team,
    valid_at: validAt,
    invalid_at: invalidAt,
    project: demoProject,
    surface: 'shared' as const,
    relation: 'own' as const,
  }
}

const demoMemories = [
  memoryRow(
    'M1',
    '[Alice] Alice joins the Marketing team on 2026-05-01 and is assigned to the Widget product.',
    ['Alice', 'Marketing', 'Widget'],
    demoProject,
    0.99,
  ),
  memoryRow(
    'M2',
    '[Bob] Bob joins Marketing on 2026-05-15 to assist Alice on the Widget product.',
    ['Bob', 'Marketing', 'Widget', 'Alice'],
  ),
  memoryRow(
    'M3',
    '[Alice] Alice moves from Marketing to the Sales team on 2026-06-10.',
    ['Alice', 'Marketing', 'Sales'],
  ),
  memoryRow(
    'M4',
    '[Widget] Widget is delayed on 2026-06-12 because Supplier Z is late.',
    ['Widget', 'Supplier Z'],
  ),
  memoryRow(
    'M5',
    '[Charlie] Charlie is hired on 2026-07-01 to replace Alice in Marketing and inherits the Widget project.',
    ['Charlie', 'Alice', 'Marketing', 'Widget'],
  ),
  memoryRow(
    'M6',
    '[Sales] Sales celebrates record Q2 revenue on 2026-07-15 and includes Alice contribution.',
    ['Sales', 'Alice'],
  ),
  memoryRow(
    'M7',
    '[Widget] Supplier Z delivered the missing parts on 2026-07-20 and the Widget delay is resolved.',
    ['Widget', 'Supplier Z'],
  ),
  memoryRow(
    'M8',
    '[Alice] Alice changes her surname to Alice Smith on 2026-08-01.',
    ['Alice', 'Alice Smith', 'Sales'],
  ),
]

const widgeonDistractor = memoryRow(
  'M9',
  '[Widgeon] Widgeon is an unrelated product in other_project with a similar name to Widget.',
  ['Widgeon'],
  otherProject,
  0.91,
)

const aliceMarketing = fact(
  'F1',
  'MEMBER_OF',
  'Alice',
  'Marketing',
  'Alice was a member of Marketing from 2026-05-01 until she moved to Sales.',
  '2026-05-01T00:00:00.000Z',
  '2026-06-10T00:00:00.000Z',
)
const aliceSales = fact(
  'F2',
  'MEMBER_OF',
  'Alice',
  'Sales',
  'Alice has been a member of Sales since 2026-06-10.',
  '2026-06-10T00:00:00.000Z',
)
const bobMarketing = fact(
  'F3',
  'MEMBER_OF',
  'Bob',
  'Marketing',
  'Bob has been a member of Marketing since 2026-05-15.',
  '2026-05-15T00:00:00.000Z',
)
const charlieMarketing = fact(
  'F4',
  'MEMBER_OF',
  'Charlie',
  'Marketing',
  'Charlie has been a member of Marketing since 2026-07-01.',
  '2026-07-01T00:00:00.000Z',
)
const aliceWidget = fact(
  'F5',
  'WORKS_ON',
  'Alice',
  'Widget',
  'Alice worked on Widget from 2026-05-01 until she left Marketing.',
  '2026-05-01T00:00:00.000Z',
  '2026-06-10T00:00:00.000Z',
)
const bobWidget = fact(
  'F6',
  'WORKS_ON',
  'Bob',
  'Widget',
  'Bob works on Widget from 2026-05-15 onward.',
  '2026-05-15T00:00:00.000Z',
)
const charlieWidget = fact(
  'F7',
  'WORKS_ON',
  'Charlie',
  'Widget',
  'Charlie works on Widget from 2026-07-01 onward after inheriting the project from Alice.',
  '2026-07-01T00:00:00.000Z',
)
const widgetDelayed = fact(
  'F8',
  'DELAYED_BY',
  'Widget',
  'Supplier Z',
  'Widget was delayed by Supplier Z from 2026-06-12 until Supplier Z delivered missing parts.',
  '2026-06-12T00:00:00.000Z',
  '2026-07-20T00:00:00.000Z',
)
const widgetNormal = fact(
  'F9',
  'NORMAL_STATUS',
  'Widget',
  'Supplier Z',
  'Widget delay was resolved when Supplier Z delivered missing parts on 2026-07-20.',
  '2026-07-20T00:00:00.000Z',
)
const aliceName = fact(
  'F10',
  'HAS_NAME',
  'Alice',
  'Alice Smith',
  'Alice has the name Alice Smith from 2026-08-01 onward.',
  '2026-08-01T00:00:00.000Z',
)
const aliceOldName = fact(
  'F11',
  'HAS_NAME',
  'Alice',
  'Alice',
  'Alice used the prior name Alice before the Alice Smith update.',
  '2026-05-01T00:00:00.000Z',
  '2026-08-01T00:00:00.000Z',
)

const graphFacts = [
  aliceMarketing,
  aliceSales,
  bobMarketing,
  charlieMarketing,
  aliceWidget,
  bobWidget,
  charlieWidget,
  widgetDelayed,
  widgetNormal,
  aliceName,
  aliceOldName,
]

const widgetTimeline = [
  { ...aliceWidget, status: 'invalid' as const },
  { ...bobWidget, status: 'valid' as const },
  { ...widgetDelayed, status: 'invalid' as const },
  { ...charlieWidget, status: 'valid' as const },
  { ...widgetNormal, status: 'valid' as const },
]

const contradictions = [
  { superseded: widgetDelayed, superseded_by: widgetNormal },
  { superseded: aliceMarketing, superseded_by: aliceSales },
  { superseded: aliceOldName, superseded_by: aliceName },
]

type BenchmarkReportState = {
  graphScenario?: {
    status: 'passed'
    counts: Record<string, unknown>
    memoryIds: string[]
    entities: string[]
    centerNodeUuid: string | null
    graphFacts: Array<{ uuid: string; name: string; source_name: string | null; target_name: string | null; invalid_at: string | null }>
    timeline: Array<{ uuid: string; status: string }>
    contradictions: Array<{ superseded: string; supersededBy: string | null }>
    measurement: RecallMeasurement
  }
  scopeScenario?: {
    status: 'passed'
    counts: Record<string, unknown>
    excludedProject: string
    distractorId: string
    measurement: RecallMeasurement
  }
}

const reportState: BenchmarkReportState = {}

function benchmarkReportPath() {
  return new URL('../../../.local/benchmark-results/recall-context-benchmark-latest.md', import.meta.url)
}

function formatBenchmarkReport(state: BenchmarkReportState): string {
  const lines = [
    '# Recall Context Benchmark Results',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    'Benchmark source: documentation/stack-architecture/benchmarking.md',
    'Test file: apps/mcp/test/recall-context-benchmark.test.ts',
    '',
    '## Summary',
    '',
    `- Graph/timeline/contradiction scenario: ${state.graphScenario?.status ?? 'not run'}`,
    `- Project-scope distractor scenario: ${state.scopeScenario?.status ?? 'not run'}`,
    '',
  ]

  if (state.graphScenario) {
    lines.push(
      '## Graph Scenario',
      '',
      `- Counts: \`${JSON.stringify(state.graphScenario.counts)}\``,
      `- Memory IDs: ${state.graphScenario.memoryIds.join(', ')}`,
      `- Entities: ${state.graphScenario.entities.join(', ')}`,
      `- Timeline center node: ${state.graphScenario.centerNodeUuid ?? 'none'}`,
      `- Serialized MCP result: ${state.graphScenario.measurement.resultBytes.toLocaleString()} bytes / ${state.graphScenario.measurement.estimatedTokens.toLocaleString()} estimated tokens`,
      `- Fact occupancy: ${state.graphScenario.measurement.factOccurrences} occurrences / ${state.graphScenario.measurement.uniqueFacts} unique / ${state.graphScenario.measurement.duplicateOccurrences} duplicates`,
      `- Duplicate fact bytes: ${state.graphScenario.measurement.duplicateFactBytes.toLocaleString()}`,
      '',
      '| Fact | Relation | Source | Target | Status |',
      '|---|---|---|---|---|',
      ...state.graphScenario.graphFacts.map((fact) =>
        `| ${fact.uuid} | ${fact.name} | ${fact.source_name ?? ''} | ${fact.target_name ?? ''} | ${fact.invalid_at ? 'invalid' : 'valid'} |`,
      ),
      '',
      '| Timeline fact | Status |',
      '|---|---|',
      ...state.graphScenario.timeline.map((entry) => `| ${entry.uuid} | ${entry.status} |`),
      '',
      '| Superseded fact | Superseded by |',
      '|---|---|',
      ...state.graphScenario.contradictions.map((entry) => `| ${entry.superseded} | ${entry.supersededBy ?? 'none'} |`),
      '',
    )
  }

  if (state.scopeScenario) {
    lines.push(
      '## Scope Scenario',
      '',
      `- Counts: \`${JSON.stringify(state.scopeScenario.counts)}\``,
      `- Distractor memory: ${state.scopeScenario.distractorId}`,
      `- Excluded project: ${state.scopeScenario.excludedProject}`,
      `- Serialized MCP result: ${state.scopeScenario.measurement.resultBytes.toLocaleString()} bytes / ${state.scopeScenario.measurement.estimatedTokens.toLocaleString()} estimated tokens`,
      '',
    )
  }

  return `${lines.join('\n')}\n`
}

function writeBenchmarkReport() {
  const dir = new URL('../../../.local/benchmark-results/', import.meta.url)
  mkdirSync(dir, { recursive: true })
  writeFileSync(benchmarkReportPath(), formatBenchmarkReport(reportState), 'utf8')
}

function graphFactsForEntity(name: string) {
  return graphFacts.filter((edge) => edge.source_name === name || edge.target_name === name)
}

describe('recall_context memory benchmark contract', () => {
  afterAll(() => {
    writeBenchmarkReport()
  })

  it('assembles the Widget graph picture from semantic hits, graph facts, timelines, and contradictions', async () => {
    const api = {
      post: vi.fn(async (path: string, body?: Record<string, unknown>) => {
        if (path === '/memories/search') {
          expect(body).toMatchObject({
            query: expect.stringContaining('Widget'),
            project: demoProject,
            limit: 8,
          })
          return { results: demoMemories, counts: { own: 8, other: 0 } }
        }
        if (path === '/graph/search') {
          expect(body).toMatchObject({
            query: expect.stringContaining('Widget'),
            limit: 20,
            validOnly: false,
            scope: 'own',
          })
          return { facts: graphFacts }
        }
        throw new Error(`unexpected POST ${path}`)
      }),
      get: vi.fn(async (path: string, query?: Record<string, unknown>) => {
        if (path.startsWith('/graph/entity/')) {
          const name = decodeURIComponent(path.slice('/graph/entity/'.length))
          expect(query).toMatchObject({ limit: 20, scope: 'own' })
          return { name, facts: graphFactsForEntity(name) }
        }
        if (path === '/graph/timeline') {
          expect(query).toMatchObject({
            entityUuid: nodeId('Widget'),
            includeInvalid: true,
            limit: 20,
            scope: 'own',
          })
          return { entityUuid: nodeId('Widget'), entries: widgetTimeline }
        }
        if (path === '/graph/contradictions') {
          expect(query).toMatchObject({
            entityUuid: nodeId('Widget'),
            limit: 20,
            scope: 'own',
          })
          return { contradictions }
        }
        throw new Error(`unexpected GET ${path}`)
      }),
    }
    const tools = collectAllTools(api, runtime)
    const recall = tools.get('recall_context')!

    const result = await recall.handler({
      query:
        'Provide a chronological narrative of the Widget product: who worked on it, which teams they belonged to, delays and resolutions, and participant name or role changes.',
      project: demoProject,
      scope: 'own',
      entityNames: ['Widget', 'Alice', 'Bob', 'Charlie', 'Marketing', 'Sales', 'Supplier Z'],
      memoryLimit: 8,
      graphLimit: 20,
      entityLimit: 20,
      timelineLimit: 20,
      includeInvalid: true,
      validOnly: false,
    })

    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toBeDefined()
    z.object(recall.options.outputSchema!).strict().parse(result.structuredContent)

    const context = result.structuredContent!
    expect(context).toMatchObject({
      schemaVersion: 2,
      query: expect.stringContaining('chronological narrative'),
      project: demoProject,
      surface: 'personal',
      counts: {
        available: {
          memories: 8,
          graphFacts: 11,
          entityExpansions: 8,
          timelineEntries: 5,
          contradictions: 3,
        },
        included: {
          memories: 8,
          graphFacts: 11,
          entityExpansions: 8,
          timelineEntries: 5,
          contradictions: 3,
          uniqueFacts: 11,
        },
        omitted: {
          memories: 0,
          graphFacts: 0,
          entityExpansions: 0,
          entityFacts: 0,
          timelineEntries: 0,
          contradictions: 0,
          uniqueFacts: 0,
        },
      },
      memoryCounts: { own: 8, other: 0 },
    })

    const followup = context.followup as { memoryIds: string[]; entities: string[]; centerNodeUuids: string[] }
    expect(followup.memoryIds).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'])
    expect(followup.memoryIds).not.toContain('M9')
    expect(followup.entities).toEqual(['Widget', 'Alice', 'Bob', 'Charlie', 'Marketing', 'Sales', 'Supplier Z', 'Alice Smith'])
    expect(followup.centerNodeUuids[0]).toBe(nodeId('Widget'))

    const factRegistry = context.facts as Record<string, (typeof graphFacts)[number]>
    const graph = context.graph as { factRefs: string[] }
    expect(graph.factRefs).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11'])
    expect(Object.values(factRegistry).every((edge) => edge.project === demoProject && edge.surface === 'shared')).toBe(true)
    expect(Object.values(factRegistry).some((edge) => edge.source_name === 'Widgeon' || edge.target_name === 'Widgeon')).toBe(false)

    const entities = context.entities as Array<{ name: string; factRefs: string[] }>
    expect(entities.find((entry) => entry.name === 'Widget')?.factRefs).toEqual([
      'F5',
      'F6',
      'F7',
      'F8',
      'F9',
    ])
    expect(entities.find((entry) => entry.name === 'Marketing')?.factRefs).toEqual(['F1', 'F3', 'F4'])
    expect(entities.find((entry) => entry.name === 'Supplier Z')?.factRefs).toEqual(['F8', 'F9'])

    const timeline = context.timeline as { centerNodeUuid: string | null; entries: Array<{ factRef: string; status: string }> }
    expect(timeline.centerNodeUuid).toBe(nodeId('Widget'))
    expect(timeline.entries.map((entry) => [entry.factRef, entry.status])).toEqual([
      ['F5', 'invalid'],
      ['F6', 'valid'],
      ['F8', 'invalid'],
      ['F7', 'valid'],
      ['F9', 'valid'],
    ])

    const contradictionResult = context.contradictions as { results: Array<{ supersededRef: string; supersededByRef: string | null }> }
    expect(contradictionResult.results.map((item) => [item.supersededRef, item.supersededByRef])).toEqual([
      ['F8', 'F9'],
      ['F1', 'F2'],
      ['F11', 'F10'],
    ])

    const summary = String(context.contextSummary)
    for (const expected of ['Alice', 'Bob', 'Charlie', 'Marketing', 'Widget', 'Supplier Z', 'superseded']) {
      expect(summary).toContain(expected)
    }
    expect(summary).not.toContain('Widgeon')
    expect(summary).not.toContain(demoMemories[0]!.content)

    const measurement = measureRecallResult(result)
    expect(measurement.responseSchemaVersion).toBe(2)
    expect(measurement.danglingFactRefs).toEqual([])
    expect(measurement.duplicateFactBytes).toBe(0)
    expect(measurement.resultBytes).toBeLessThanOrEqual(16 * 1024)

    reportState.graphScenario = {
      status: 'passed',
      counts: context.counts as Record<string, unknown>,
      memoryIds: followup.memoryIds,
      entities: followup.entities,
      centerNodeUuid: timeline.centerNodeUuid,
      graphFacts: graph.factRefs.map((ref) => factRegistry[ref]!).map((edge) => ({
        uuid: edge.uuid,
        name: edge.name,
        source_name: edge.source_name,
        target_name: edge.target_name,
        invalid_at: edge.invalid_at,
      })),
      timeline: timeline.entries.map((entry) => ({ uuid: entry.factRef, status: entry.status })),
      contradictions: contradictionResult.results.map((item) => ({
        superseded: item.supersededRef,
        supersededBy: item.supersededByRef,
      })),
      measurement,
    }
  })

  it('keeps the other_project Widgeon distractor out of demo_project recall', async () => {
    const api = {
      post: vi.fn(async (path: string, body?: Record<string, unknown>) => {
        if (path === '/memories/search') {
          expect(body).toMatchObject({
            query: expect.stringContaining('Widgeon'),
            project: demoProject,
          })
          return { results: [], counts: { own: 0, other: 0 } }
        }
        if (path === '/graph/search') return { facts: [] }
        throw new Error(`unexpected POST ${path}`)
      }),
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/graph/entity/')) return { name: decodeURIComponent(path.slice('/graph/entity/'.length)), facts: [] }
        if (path === '/graph/timeline') return { entityUuid: null, entries: [] }
        if (path === '/graph/contradictions') return { contradictions: [] }
        throw new Error(`unexpected GET ${path}`)
      }),
    }
    const tools = collectAllTools(api, runtime)

    const result = await tools.get('recall_context')!.handler({
      query: 'Is the Widgeon product part of the Widget project?',
      project: demoProject,
      scope: 'own',
      memoryLimit: 5,
      graphLimit: 10,
      entityLimit: 10,
      timelineLimit: 10,
    })

    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 2,
      counts: {
        available: {
          memories: 0,
          graphFacts: 0,
          entityExpansions: 0,
          entityFacts: 0,
          timelineEntries: 0,
          contradictions: 0,
          uniqueFacts: 0,
        },
        included: {
          memories: 0,
          graphFacts: 0,
          entityExpansions: 0,
          entityFacts: 0,
          timelineEntries: 0,
          contradictions: 0,
          uniqueFacts: 0,
        },
      },
      memoryCounts: { own: 0, other: 0 },
    })
    expect(String(result.structuredContent?.contextSummary ?? '')).toContain('Memories: none.')
    expect(widgeonDistractor.project).toBe(otherProject)

    reportState.scopeScenario = {
      status: 'passed',
      counts: result.structuredContent?.counts as Record<string, unknown>,
      excludedProject: otherProject,
      distractorId: widgeonDistractor.id,
      measurement: measureRecallResult(result),
    }
  })

  it('enforces the hard result budget with atomic previews and references on oversized evidence', async () => {
    const oversizedMemories = Array.from({ length: 20 }, (_, index) => memoryRow(
      `LM${index}`,
      `[component_large_${index}] ${'memory evidence '.repeat(900)}`,
      [`component_large_${index}`],
    ))
    const oversizedFacts = Array.from({ length: 50 }, (_, index) => fact(
      `LF${index}`,
      'RELATES_TO',
      `Source ${index}`,
      `Target ${index}`,
      `Large fact ${index}: ${'graph evidence '.repeat(500)}`,
      '2026-08-01T00:00:00.000Z',
    ))
    const api = {
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search') return { results: oversizedMemories, counts: { own: 20, other: 0 } }
        if (path === '/graph/search') return { facts: oversizedFacts }
        throw new Error(`unexpected POST ${path}`)
      }),
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/graph/entity/')) return { name: decodeURIComponent(path.slice('/graph/entity/'.length)), facts: oversizedFacts }
        if (path === '/graph/timeline') return { entityUuid: nodeId('Source 0'), entries: oversizedFacts.map((edge) => ({ ...edge, status: 'valid' as const })) }
        if (path === '/graph/contradictions') return { contradictions: oversizedFacts.slice(0, 24).map((edge, index) => ({ superseded: edge, superseded_by: oversizedFacts[index + 1] ?? null })) }
        throw new Error(`unexpected GET ${path}`)
      }),
    }
    const recall = collectAllTools(api, runtime).get('recall_context')!
    const result = await recall.handler({
      query: 'Summarize the oversized graph evidence without breaking references.',
      project: demoProject,
      entityNames: ['Widget'],
      memoryLimit: 20,
      graphLimit: 50,
      entityLimit: 30,
      timelineLimit: 100,
      includeInvalid: true,
      validOnly: false,
    })

    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    z.object(recall.options.outputSchema!).strict().parse(result.structuredContent)
    const measurement = measureRecallResult(result)
    const context = result.structuredContent as {
      budget: { hardLimitBytes: number; resultBytes: number; truncated: boolean; memoryPreviews: number; factPreviews: number }
      counts: { included: { memories: number; uniqueFacts: number }; omitted: { memories: number; uniqueFacts: number } }
      memoryCounts: { own: number; other: number }
      followup: { memoryIds: string[] }
    }
    expect(measurement.resultBytes).toBeLessThanOrEqual(24 * 1024)
    expect(context.budget.resultBytes).toBe(measurement.resultBytes)
    expect(context.budget.truncated).toBe(true)
    expect(context.budget.memoryPreviews + context.budget.factPreviews).toBeGreaterThan(0)
    expect(context.counts.included.memories).toBeGreaterThan(0)
    expect(context.counts.included.uniqueFacts).toBeGreaterThan(0)
    expect(context.counts.omitted.memories + context.counts.omitted.uniqueFacts).toBeGreaterThan(0)
    expect(context.memoryCounts).toEqual({ own: 20, other: 0 })
    expect(context.followup.memoryIds).toEqual(oversizedMemories.map((memory) => memory.id))
    expect(measurement.danglingFactRefs).toEqual([])
  })
})
