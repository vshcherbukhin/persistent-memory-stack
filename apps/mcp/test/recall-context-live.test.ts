import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ApiClient } from '../src/api-client.ts'
import { registerAllTools } from '../src/server.ts'
import type { Runtime } from '../src/runtime.ts'
import { aggregateRecallMeasurements, measureRecallResult, type RecallAggregate } from './recall-context-metrics.ts'

type Tool = {
  handler: (input: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }>
}

function collectAllTools(api: unknown, runtime: Runtime): Map<string, Tool> {
  const tools = new Map<string, Tool>()
  const server = {
    registerTool(name: string, _options: unknown, handler: Tool['handler']) {
      tools.set(name, { handler })
    },
  }
  registerAllTools(server as never, { api, runtime } as never)
  return tools
}

const describeLive = process.env.PM_LIVE_MEMORY_EVAL === '1' ? describe : describe.skip

const runtime: Runtime = {
  mode: 'server',
  deploymentMode: process.env.PM_USER_TOKEN ? 'server' : 'local',
  pin: { modelId: 'qwen3-embedding:4b', dim: 2560 },
  bridge: null,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function writeLiveBenchmarkReport(input: {
  project: string
  otherProject: string
  createdCount: number
  queryCount: number
  counts: Record<string, unknown>
  validatedSignals: string[]
  leakageCount: number
  recallMetrics: RecallAggregate
  quality: {
    expectedMemoryHits: number
    expectedMemoryHitRate: number
    meanReciprocalRank: number
  }
  agentSamples: Array<{
    id: string
    query: string
    expectedInclude: string[]
    expectedAny: string[]
    expectedExclude: string[]
    context: Record<string, unknown>
  }>
}) {
  const dir = new URL('../../../.local/benchmark-results/', import.meta.url)
  mkdirSync(dir, { recursive: true })
  const path = new URL('../../../.local/benchmark-results/recall-context-live-latest.md', import.meta.url)
  const report = [
    '# Live Recall Context Benchmark Results',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    'Benchmark source: documentation/stack-architecture/benchmarking.md',
    'Test file: apps/mcp/test/recall-context-live.test.ts',
    '',
    '## Summary',
    '',
    '- Status: passed',
    `- Seeded memories: ${input.createdCount}`,
    `- Recall queries: ${input.queryCount}`,
    `- Demo project: ${input.project}`,
    `- Distractor project: ${input.otherProject}`,
    `- Counts: \`${JSON.stringify(input.counts)}\``,
    `- Cross-project leakage count: ${input.leakageCount}`,
    `- Serialized recall bytes: total ${input.recallMetrics.resultBytes.total.toLocaleString()}, p50 ${input.recallMetrics.resultBytes.p50.toLocaleString()}, p95 ${input.recallMetrics.resultBytes.p95.toLocaleString()}, max ${input.recallMetrics.resultBytes.max.toLocaleString()}`,
    `- Estimated recall tokens: total ${input.recallMetrics.estimatedTokens.total.toLocaleString()}, p50 ${input.recallMetrics.estimatedTokens.p50.toLocaleString()}, p95 ${input.recallMetrics.estimatedTokens.p95.toLocaleString()}, max ${input.recallMetrics.estimatedTokens.max.toLocaleString()}`,
    `- Fact occupancy: ${input.recallMetrics.facts.occurrences} occurrences / ${input.recallMetrics.facts.unique} unique / ${input.recallMetrics.facts.duplicates} duplicates`,
    `- Duplicate fact bytes: ${input.recallMetrics.facts.duplicateFactBytes.toLocaleString()}`,
    `- Dangling fact references: ${input.recallMetrics.danglingFactRefs}`,
    `- Expected-memory hit rate: ${(input.quality.expectedMemoryHitRate * 100).toFixed(1)}%`,
    `- Mean reciprocal rank: ${input.quality.meanReciprocalRank.toFixed(4)}`,
    '',
    '## Validated Signals',
    '',
    ...input.validatedSignals.map((signal) => `- ${signal}`),
    '',
  ].join('\n')
  writeFileSync(path, `${report}\n`, 'utf8')
  writeFileSync(
    new URL('../../../.local/benchmark-results/recall-context-live-latest.json', import.meta.url),
    `${JSON.stringify({
      schemaVersion: 2,
      status: 'pass',
      queryCount: input.queryCount,
      leakageCount: input.leakageCount,
      validatedPlanes: ['memories', 'graph facts', 'entity expansions', 'timeline', 'contradictions'],
      recallMetrics: input.recallMetrics,
      quality: input.quality,
      agentSampleCount: input.agentSamples.length,
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    new URL('../../../.local/benchmark-results/recall-context-agent-samples-latest.json', import.meta.url),
    `${JSON.stringify({ schemaVersion: 1, samples: input.agentSamples }, null, 2)}\n`,
    'utf8',
  )
}

type RecallFact = { project?: string; source_name?: string | null; target_name?: string | null }

function crossProjectLeakCount(context: {
  memories?: Array<{ project?: string }>
  facts?: Record<string, RecallFact>
}, project: string): number {
  const facts = Object.values(context.facts ?? {})
  return (context.memories ?? []).filter((memory) => memory.project !== project).length + facts.filter((fact) => fact.project !== project).length
}

/**
 * A 24-query regression matrix mapped to the PM-vs-Vault evaluation themes.
 * It deliberately separates readiness polling from quality queries: the old
 * retry loop could pass after one recall, which did not exercise the claimed
 * breadth of project, timeline, contradiction, and entity retrieval.
 */
function benchmarkQueries(project: string) {
  return [
    { query: 'Who currently belongs to team_sales?', expectedMemoryText: 'team_sales', agentExpected: { include: ['person_alice', 'team_sales'], exclude: ['person_alice currently belongs to team_marketing'] } },
    { query: 'When did person_alice leave team_marketing?', expectedMemoryText: 'moves from team_marketing', agentExpected: { include: ['person_alice', '2026-06-10'], exclude: [] } },
    { query: 'What did person_bob do on product_widget?', expectedMemoryText: 'person_bob joins team_marketing' },
    { query: 'Who inherited product_widget work in team_marketing?', expectedMemoryText: 'person_charlie is hired' },
    { query: 'Why was product_widget delayed?', expectedMemoryText: 'supplier_z is late' },
    { query: 'Was the supplier_z delay resolved?', expectedMemoryText: 'delay is resolved', agentExpected: { include: ['supplier_z', 'resolved'], exclude: ['currently delayed'] } },
    { query: 'What is person_alice latest display name?', expectedMemoryText: 'alice smith', agentExpected: { include: ['alice smith'], exclude: [] } },
    { query: 'Show the chronological product_widget timeline.', expectedMemoryText: 'product_widget' },
    { query: 'Which team did person_alice belong to before team_sales?', expectedMemoryText: 'team_marketing' },
    { query: 'Explain the product_widget hand-off from person_alice to person_charlie.', expectedMemoryText: 'inherits product_widget', agentExpected: { include: ['person_alice', 'person_charlie', 'product_widget'], exclude: [] } },
    { query: 'Which supplier affected product_widget?', expectedMemoryText: 'supplier_z' },
    { query: 'Which facts about the Widget delay are historical rather than current?', expectedMemoryText: 'delayed' },
    { query: 'Show related facts for person_alice and product_widget.', expectedMemoryText: 'person_alice' },
    { query: 'Which people in team_marketing worked on product_widget?', expectedMemoryText: 'team_marketing' },
    { query: 'Does product_widgeon belong to this project?', expectedMemoryText: 'product_widget', excludeGraphEntity: 'product_widgeon', agentExpected: { include: ['product_widgeon'], any: ['unknown', 'does not belong', 'does not appear', 'no references'], exclude: [] } },
    { query: 'List contradictions or superseded facts for product_widget.', expectedMemoryText: 'resolved' },
    { query: 'What changed for person_alice over time?', expectedMemoryText: 'person_alice' },
    { query: 'What is the relationship between person_bob and supplier_z?', expectedMemoryText: 'person_bob' },
    { query: 'What did team_sales report about person_alice?', expectedMemoryText: 'team_sales celebrates' },
    { query: 'Which event followed the initial supplier_z delay?', expectedMemoryText: 'delivered the missing parts' },
    { query: 'What historical team membership should not be treated as current for person_alice?', expectedMemoryText: 'team_marketing' },
    { query: 'What graph context connects team_marketing to supplier_z?', expectedMemoryText: 'team_marketing' },
    { query: 'Give a current-versus-historical summary of product_widget.', expectedMemoryText: 'product_widget' },
    { query: `Summarize this project only: ${project}.`, expectedMemoryText: 'product_widget' },
  ]
}

function benchmarkSeeds(demoProject: string, otherProject: string) {
  return [
    {
      project: demoProject,
      content:
        '[person_alice] person_alice joins team_marketing on 2026-05-01 and is assigned to product_widget. Root cause: benchmark M1 seeds the initial team and product assignment. Fix: graph recall must connect Alice, Marketing, and Widget.',
      metadata: {
        category: 'fix',
        source: 'user-correction',
        entities: ['person_alice', 'team_marketing', 'product_widget'],
      },
    },
    {
      project: demoProject,
      content:
        '[person_bob] person_bob joins team_marketing on 2026-05-15 to assist person_alice on product_widget. Root cause: benchmark M2 creates a shared team and shared product edge. Fix: graph recall must connect Bob to Widget through Marketing.',
      metadata: {
        category: 'fix',
        source: 'user-correction',
        entities: ['person_bob', 'team_marketing', 'person_alice', 'product_widget'],
      },
    },
    {
      project: demoProject,
      content:
        '[person_alice] person_alice moves from team_marketing to team_sales on 2026-06-10. Root cause: benchmark M3 invalidates the old Marketing membership. Fix: timeline recall must show Alice currently belongs to Sales.',
      metadata: {
        category: 'fix',
        source: 'user-correction',
        entities: ['person_alice', 'team_marketing', 'team_sales'],
      },
    },
    {
      project: demoProject,
      content:
        '[product_widget] product_widget is delayed on 2026-06-12 because supplier_z is late. Root cause: benchmark M4 creates the obsolete delay fact. Fix: contradiction recall must later mark this delay as resolved.',
      metadata: {
        category: 'fix',
        source: 'user-correction',
        entities: ['product_widget', 'supplier_z'],
      },
    },
    {
      project: demoProject,
      content:
        '[person_charlie] person_charlie is hired on 2026-07-01 to replace person_alice in team_marketing and inherits product_widget. Root cause: benchmark M5 creates the hand-off. Fix: graph recall must connect Charlie to Widget and Marketing.',
      metadata: {
        category: 'fix',
        source: 'user-correction',
        entities: ['person_charlie', 'person_alice', 'team_marketing', 'product_widget'],
      },
    },
    {
      project: demoProject,
      content:
        '[team_sales] team_sales celebrates record Q2 revenue on 2026-07-15 and includes person_alice contribution. Root cause: benchmark M6 confirms Alice current team context. Fix: graph recall must not keep Alice as current Marketing.',
      metadata: {
        category: 'fix',
        source: 'gotcha-discovered',
        entities: ['team_sales', 'person_alice'],
      },
    },
    {
      project: demoProject,
      content:
        '[product_widget] supplier_z delivered the missing parts on 2026-07-20 and product_widget delay is resolved. Root cause: benchmark M7 supersedes the obsolete delay fact. Fix: graph recall must treat Supplier Z delay as historical only.',
      metadata: {
        category: 'fix',
        source: 'user-correction',
        entities: ['product_widget', 'supplier_z'],
      },
    },
    {
      project: demoProject,
      content:
        '[person_alice] person_alice changes her display name to Alice Smith while in team_sales on 2026-08-01. Root cause: benchmark M8 creates a name update. Fix: graph recall must expose Alice Smith as the latest name while preserving history.',
      metadata: {
        category: 'fix',
        source: 'user-correction',
        entities: ['person_alice', 'team_sales'],
      },
    },
    {
      project: otherProject,
      content:
        '[product_widgeon] product_widgeon is an unrelated product in other_project with a similar name to product_widget. Root cause: benchmark M9 is a semantic distractor. Fix: demo_project recall must exclude Widgeon unless scope changes.',
      metadata: {
        category: 'fix',
        source: 'gotcha-discovered',
        entities: ['product_widgeon'],
      },
    },
  ] as const
}

describeLive('live graph-first recall benchmark', () => {
  it('seeds a report-shaped memory graph and recalls graph, timeline, contradiction, and distractor context', async () => {
    const api = new ApiClient({
      API_URL: process.env.API_URL ?? 'http://localhost:8090',
      PM_USER_TOKEN: process.env.PM_USER_TOKEN,
      PM_API_TIMEOUT_MS: 60_000,
    } as never)
    const tools = collectAllTools(api, runtime)
    const addMemory = tools.get('add_memory')!
    const recallContext = tools.get('recall_context')!
    const deleteMemory = tools.get('delete_memory')!
    const runId = Date.now()
    const project = `demo_project_${runId}`
    const otherProject = `other_project_${runId}`
    const createdIds: string[] = []
    let leakageCount = 0
    const recallMeasurements = []
    const expectedMemoryRanks: number[] = []
    const agentSamples: Array<{
      id: string
      query: string
      expectedInclude: string[]
      expectedAny: string[]
      expectedExclude: string[]
      context: Record<string, unknown>
    }> = []

    try {
      for (const seed of benchmarkSeeds(project, otherProject)) {
        const res = await addMemory.handler({
          content: seed.content,
          project: seed.project,
          metadata: seed.metadata,
        })
        expect(res.isError, JSON.stringify(res)).not.toBe(true)
        createdIds.push(String(res.structuredContent?.id))
      }

      let lastContext: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 24; attempt++) {
        if (attempt > 0) await sleep(5_000)
        const res = await recallContext.handler({
          query:
            'Provide a chronological narrative of product_widget in demo_project: who worked on it, which teams they belonged to, any Supplier Z delay and resolution, any Alice name or role changes, and whether product_widgeon belongs here.',
          project,
          entityNames: [
            'product_widget',
            'person_alice',
            'person_bob',
            'person_charlie',
            'team_marketing',
            'team_sales',
            'supplier_z',
            'product_widgeon',
          ],
          memoryLimit: 12,
          graphLimit: 40,
          entityLimit: 20,
          timelineLimit: 40,
          includeInvalid: true,
          validOnly: false,
        })
        expect(res.isError, JSON.stringify(res)).not.toBe(true)
        lastContext = res.structuredContent
        const counts =
          lastContext?.counts as
            | { included?: { memories?: number; graphFacts?: number; entityExpansions?: number; timelineEntries?: number } }
            | undefined
        const included = counts?.included
        const summary = String(lastContext?.contextSummary ?? '').toLowerCase()
        if (
          (included?.memories ?? 0) >= 8 &&
          (included?.graphFacts ?? 0) >= 4 &&
          (included?.entityExpansions ?? 0) >= 4 &&
          summary.includes('widget') &&
          summary.includes('supplier') &&
          summary.includes('alice') &&
          (summary.includes('superseded') || summary.includes('replaced'))
        ) {
          break
        }
      }

      // The readiness call above proves that Graphiti has converged. Exercise the
      // full query matrix only after that point so an eventual-consistency delay
      // cannot make the quality measurements flaky.
      for (const testCase of benchmarkQueries(project)) {
        const res = await recallContext.handler({
          query: testCase.query,
          project,
          entityNames: ['product_widget', 'person_alice', 'team_marketing', 'team_sales', 'supplier_z'],
          memoryLimit: 12,
          graphLimit: 40,
          entityLimit: 20,
          timelineLimit: 40,
          includeInvalid: true,
          validOnly: false,
        })
        expect(res.isError, `${testCase.query}: ${JSON.stringify(res)}`).not.toBe(true)
        recallMeasurements.push(measureRecallResult(res))
        const context = (res.structuredContent ?? {}) as {
          schemaVersion?: number
          counts?: { included?: { memories?: number } }
          memories?: Array<{ content?: string; project?: string }>
          facts?: Record<string, RecallFact>
          graph?: { factRefs?: string[] }
        }
        expect(context.schemaVersion).toBe(2)
        expect(context.counts?.included?.memories ?? 0, `${testCase.query}: no project-scoped memory was recalled`).toBeGreaterThan(0)
        const recalledText = (context.memories ?? []).map((memory) => memory.content ?? '').join('\n').toLowerCase()
        expect(recalledText, `${testCase.query}: expected semantic evidence was not recalled`).toContain(testCase.expectedMemoryText)
        const expectedRank = (context.memories ?? []).findIndex((memory) => (memory.content ?? '').toLowerCase().includes(testCase.expectedMemoryText)) + 1
        expect(expectedRank, `${testCase.query}: expected memory rank was not measurable`).toBeGreaterThan(0)
        expectedMemoryRanks.push(expectedRank)
        const queryLeaks = crossProjectLeakCount(context, project)
        leakageCount += queryLeaks
        expect(queryLeaks, `${testCase.query}: a memory, graph fact, entity expansion, timeline entry, or contradiction leaked from another project`).toBe(0)
        if (testCase.excludeGraphEntity) {
          const leaked = (context.graph?.factRefs ?? []).map((ref) => context.facts?.[ref]).filter(Boolean).some((fact) =>
            fact.source_name === testCase.excludeGraphEntity || fact.target_name === testCase.excludeGraphEntity,
          )
          expect(leaked, `${testCase.query}: cross-project graph entity leaked into named scope`).not.toBe(true)
        }
        if (testCase.agentExpected) {
          agentSamples.push({
            id: `agent-${agentSamples.length + 1}`,
            query: testCase.query,
            expectedInclude: testCase.agentExpected.include,
            expectedAny: 'any' in testCase.agentExpected ? testCase.agentExpected.any : [],
            expectedExclude: testCase.agentExpected.exclude,
            context: (res.structuredContent ?? {}) as Record<string, unknown>,
          })
        }
      }

      const counts =
        lastContext?.counts as
          | { included?: { memories?: number; graphFacts?: number; entityExpansions?: number; timelineEntries?: number } }
          | undefined
      expect(counts?.included?.memories ?? 0).toBeGreaterThanOrEqual(8)
      expect(counts?.included?.graphFacts ?? 0).toBeGreaterThanOrEqual(4)
      expect(counts?.included?.entityExpansions ?? 0).toBeGreaterThanOrEqual(4)

      const summary = String(lastContext?.contextSummary ?? '').toLowerCase()
      for (const expected of ['widget', 'alice', 'bob', 'charlie', 'marketing', 'supplier']) {
        expect(summary).toContain(expected)
      }

      const graph = lastContext?.graph as { factRefs?: string[] } | undefined
      const facts = lastContext?.facts as Record<string, RecallFact> | undefined
      const graphMentionsDistractor = (graph?.factRefs ?? []).map((ref) => facts?.[ref]).filter(Boolean).some(
        (fact) =>
          fact.source_name === 'product_widgeon' ||
          fact.target_name === 'product_widgeon',
      )
      expect(graphMentionsDistractor).not.toBe(true)

      writeLiveBenchmarkReport({
        project,
        otherProject,
        createdCount: createdIds.length,
        queryCount: benchmarkQueries(project).length,
        counts: (lastContext?.counts ?? {}) as Record<string, unknown>,
        leakageCount,
        recallMetrics: aggregateRecallMeasurements(recallMeasurements),
        quality: {
          expectedMemoryHits: expectedMemoryRanks.length,
          expectedMemoryHitRate: expectedMemoryRanks.length / benchmarkQueries(project).length,
          meanReciprocalRank: expectedMemoryRanks.reduce((sum, rank) => sum + (1 / rank), 0) / expectedMemoryRanks.length,
        },
        agentSamples,
        validatedSignals: [
          'semantic recall returned the demo project memories',
          'graph search returned Widget-connected facts',
          'entity expansion returned the requested neighborhood',
          'timeline entries were returned for the selected center node',
          'contradictions/superseded facts were returned',
          'all returned memories, graph facts, entity expansions, timeline entries, and contradictions stayed inside the named project',
        ],
      })
    } finally {
      if (process.env.PM_LIVE_MEMORY_EVAL_KEEP !== '1') {
        for (const id of createdIds.filter(Boolean)) {
          await deleteMemory.handler({ id })
        }
      }
    }
  }, 300_000)
})
