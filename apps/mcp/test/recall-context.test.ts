import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { registerAllTools } from '../src/server.ts'
import type { Runtime } from '../src/runtime.ts'

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

const memoryRow = {
  id: 'mem-alpha-auth',
  content:
    '[component_alpha_auth] AlphaAuth depends on component_beta_token_guard for request validation; do not route new auth checks through protocol_legacy_guard.',
  category: 'fix',
  shape: 'atomic',
  entities: ['component_alpha_auth', 'component_beta_token_guard', 'protocol_legacy_guard'],
  project: 'persistent-memory',
  sessionId: null,
  createdById: 'user-1',
  score: 0.94,
  sourceTeam: 'QA',
  isOwnTeam: true,
  createdAt: '2026-07-01T10:00:00.000Z',
  recordUpdatedAt: '2026-07-01T10:00:00.000Z',
  memoryTier: 'semantic',
  sourceProvenance: 'user-correction',
  confidence: 0.97,
}

const betaMemoryRow = {
  id: 'mem-beta-token-guard',
  content:
    '[component_beta_token_guard] BetaTokenGuard replaced protocol_legacy_guard on 2026-06-20 after the legacy guard accepted stale tokens.',
  category: 'fix',
  shape: 'atomic',
  entities: ['component_beta_token_guard', 'protocol_legacy_guard'],
  project: 'persistent-memory',
  sessionId: null,
  createdById: 'user-1',
  score: 0.91,
  sourceTeam: 'QA',
  isOwnTeam: true,
  createdAt: '2026-07-01T10:05:00.000Z',
  recordUpdatedAt: '2026-07-01T10:05:00.000Z',
  memoryTier: 'semantic',
  sourceProvenance: 'user-correction',
  confidence: 0.96,
}

const alphaDependsOnBeta = {
  uuid: 'fact-alpha-beta',
  name: 'DEPENDS_ON',
  fact: 'component_alpha_auth DEPENDS_ON component_beta_token_guard for request validation.',
  source_node_uuid: 'node-alpha',
  target_node_uuid: 'node-beta',
  source_name: 'component_alpha_auth',
  target_name: 'component_beta_token_guard',
  group_id: 'team-qa',
  valid_at: '2026-06-20T00:00:00.000Z',
  invalid_at: null,
  project: 'persistent-memory',
  surface: 'shared',
  relation: 'own',
}

const betaReplacedLegacy = {
  uuid: 'fact-beta-legacy',
  name: 'REPLACED',
  fact: 'component_beta_token_guard REPLACED protocol_legacy_guard after stale-token incidents.',
  source_node_uuid: 'node-beta',
  target_node_uuid: 'node-legacy',
  source_name: 'component_beta_token_guard',
  target_name: 'protocol_legacy_guard',
  group_id: 'team-qa',
  valid_at: '2026-06-20T00:00:00.000Z',
  invalid_at: null,
  project: 'persistent-memory',
  surface: 'shared',
  relation: 'own',
}

const oldLegacyFact = {
  uuid: 'fact-legacy-old',
  name: 'HANDLED_AUTH',
  fact: 'protocol_legacy_guard handled AlphaAuth token validation.',
  source_node_uuid: 'node-legacy',
  target_node_uuid: 'node-alpha',
  source_name: 'protocol_legacy_guard',
  target_name: 'component_alpha_auth',
  group_id: 'team-qa',
  valid_at: '2026-05-01T00:00:00.000Z',
  invalid_at: '2026-06-20T00:00:00.000Z',
  project: 'persistent-memory',
  surface: 'shared',
  relation: 'own',
}

describe('recall_context', () => {
  it('is the always-loaded graph-first memory entrypoint', () => {
    const tools = collectAllTools({ get: vi.fn(), post: vi.fn() }, runtime)
    const recall = tools.get('recall_context')

    expect(recall).toBeDefined()
    expect(recall!.options.description).toMatch(/MANDATORY first/i)
    expect(recall!.options.description).toMatch(/graph/i)
    expect(recall!.options._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
      'openai/alwaysLoad': true,
    })
    expect(recall!.options.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    })

    for (const [name, tool] of tools) {
      if (name === 'recall_context') continue
      expect(tool.options._meta?.['anthropic/alwaysLoad']).toBeUndefined()
      expect(tool.options._meta?.['openai/alwaysLoad']).toBeUndefined()
    }
  })

  it('returns connected memories, graph facts, timeline, and contradictions as one agent-ready picture', async () => {
    const api = {
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search') return { results: [memoryRow, betaMemoryRow], counts: { own: 2, other: 0 } }
        if (path === '/graph/search') return { facts: [alphaDependsOnBeta, betaReplacedLegacy] }
        throw new Error(`unexpected POST ${path}`)
      }),
      get: vi.fn(async (path: string, query?: Record<string, unknown>) => {
        if (path === '/graph/entity/component_alpha_auth') {
          return { name: 'component_alpha_auth', facts: [alphaDependsOnBeta] }
        }
        if (path === '/graph/entity/component_beta_token_guard') {
          return { name: 'component_beta_token_guard', facts: [alphaDependsOnBeta, betaReplacedLegacy] }
        }
        if (path === '/graph/entity/protocol_legacy_guard') {
          return { name: 'protocol_legacy_guard', facts: [betaReplacedLegacy, oldLegacyFact] }
        }
        if (path === '/graph/timeline') {
          expect(query?.entityUuid).toBe('node-beta')
          return {
            entityUuid: 'node-beta',
            entries: [
              { ...oldLegacyFact, status: 'invalid' },
              { ...betaReplacedLegacy, status: 'valid' },
            ],
          }
        }
        if (path === '/graph/contradictions') {
          expect(query?.entityUuid).toBe('node-beta')
          return { contradictions: [{ superseded: oldLegacyFact, superseded_by: betaReplacedLegacy }] }
        }
        throw new Error(`unexpected GET ${path}`)
      }),
    }
    const tools = collectAllTools(api, runtime)
    const recall = tools.get('recall_context')!

    const result = await recall.handler({
      query: 'How does AlphaAuth validate tokens now?',
      project: 'persistent-memory',
      scope: 'own',
      memoryLimit: 5,
      graphLimit: 10,
      entityLimit: 5,
      timelineLimit: 10,
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toBeDefined()
    z.object(recall.options.outputSchema!).strict().parse(result.structuredContent)
    expect(api.post).toHaveBeenCalledWith('/memories/search', expect.objectContaining({
      query: 'How does AlphaAuth validate tokens now?',
      project: 'persistent-memory',
      limit: 5,
    }))
    expect(api.post).toHaveBeenCalledWith('/graph/search', expect.objectContaining({
      query: 'How does AlphaAuth validate tokens now?',
      limit: 10,
      scope: 'own',
      validOnly: false,
    }))
    expect(api.get).toHaveBeenCalledWith('/graph/entity/component_alpha_auth', expect.objectContaining({ limit: 5, scope: 'own' }))
    expect(api.get).toHaveBeenCalledWith('/graph/entity/component_beta_token_guard', expect.objectContaining({ limit: 5, scope: 'own' }))

    const context = result.structuredContent!
    expect(context).toMatchObject({
      schemaVersion: 2,
      query: 'How does AlphaAuth validate tokens now?',
      project: 'persistent-memory',
      surface: 'personal',
      counts: {
        available: {
          memories: 2,
          graphFacts: 2,
          entityExpansions: 3,
          timelineEntries: 2,
          contradictions: 1,
          uniqueFacts: 3,
        },
        included: {
          memories: 2,
          graphFacts: 2,
          entityExpansions: 3,
          timelineEntries: 2,
          contradictions: 1,
          uniqueFacts: 3,
        },
      },
    })

    const facts = Object.values(context.facts as Record<string, { fact?: string }>).map((fact) => fact.fact ?? '').join('\n')
    for (const requiredClaim of [
      alphaDependsOnBeta.fact,
      betaReplacedLegacy.fact,
      oldLegacyFact.fact,
    ]) {
      expect(facts).toContain(requiredClaim)
    }
    const factIds = new Set(Object.keys(context.facts as Record<string, unknown>))
    const referencedIds = [
      ...(context.graph as { factRefs: string[] }).factRefs,
      ...(context.entities as Array<{ factRefs: string[] }>).flatMap((entity) => entity.factRefs),
      ...(context.timeline as { entries: Array<{ factRef: string }> }).entries.map((entry) => entry.factRef),
      ...(context.contradictions as { results: Array<{ supersededRef: string; supersededByRef: string | null }> }).results
        .flatMap((entry) => [entry.supersededRef, entry.supersededByRef].filter((id): id is string => Boolean(id))),
    ]
    expect(referencedIds.every((id) => factIds.has(id))).toBe(true)
    expect((context.budget as { resultBytes: number }).resultBytes).toBeLessThanOrEqual(24 * 1024)
  })

  it('fails closed with actionable recovery when graph facts lack provenance labels', async () => {
    const { project: _project, surface: _surface, relation: _relation, ...untaggedFact } = alphaDependsOnBeta
    const api = {
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search') return { results: [], counts: { own: 0, other: 0 } }
        if (path === '/graph/search') return { facts: [untaggedFact] }
        throw new Error(`unexpected POST ${path}`)
      }),
      get: vi.fn(async () => ({ name: 'component_alpha_auth', facts: [] })),
    }
    const recall = collectAllTools(api, runtime).get('recall_context')!

    const result = await recall.handler({
      query: 'How does AlphaAuth validate tokens now?',
      project: 'persistent-memory',
      timelineLimit: 0,
    })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0]?.text).toContain('graph_response_contract_invalid')
    expect(result.content[0]?.text).toContain('Retry the same recall_context call once')
    expect(result.content[0]?.text).toContain('do not treat required recall as completed')
  })

  it('fails closed when a recall contradiction pair is malformed', async () => {
    const api = {
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search') return { results: [], counts: { own: 0, other: 0 } }
        if (path === '/graph/search') return { facts: [alphaDependsOnBeta] }
        throw new Error(`unexpected POST ${path}`)
      }),
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/graph/entity/')) return { name: 'component_alpha_auth', facts: [] }
        if (path === '/graph/timeline') return { entityUuid: 'node-alpha', entries: [] }
        if (path === '/graph/contradictions') return { contradictions: [{}] }
        throw new Error(`unexpected GET ${path}`)
      }),
    }
    const recall = collectAllTools(api, runtime).get('recall_context')!

    const result = await recall.handler({
      query: 'How does AlphaAuth validate tokens now?',
      project: 'persistent-memory',
    })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0]?.text).toContain('graph_response_contract_invalid')
  })

  it('uses one selected memory surface for both semantic and graph recall', async () => {
    const personalApi = {
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search') return { results: [], counts: { own: 0, other: 0 } }
        if (path === '/graph/search') return { facts: [] }
        throw new Error(`unexpected personal POST ${path}`)
      }),
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/project-memory-bindings/')) return { project: 'persistent-memory', surface: 'shared' }
        return { entityUuid: null, entries: [] }
      }),
    }
    const sharedApi = {
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search') return { results: [], counts: { own: 0, other: 0 } }
        if (path === '/graph/search') return { facts: [] }
        throw new Error(`unexpected shared POST ${path}`)
      }),
      get: vi.fn(async () => ({ entityUuid: null, entries: [] })),
    }
    const routedRuntime: Runtime = {
      ...runtime,
      memorySurfaces: {
        defaultSurface: 'personal',
        personal: { api: personalApi, runtime },
        shared: { api: sharedApi, runtime },
      },
    }
    const tools = collectAllTools(sharedApi, routedRuntime)

    await tools.get('recall_context')!.handler({
      surface: 'shared',
      query: 'shared graph picture',
      project: 'persistent-memory',
      memoryLimit: 2,
      graphLimit: 2,
      timelineLimit: 2,
    })

    expect(sharedApi.post).toHaveBeenCalledWith('/memories/search', expect.any(Object))
    expect(sharedApi.post).toHaveBeenCalledWith('/graph/search', expect.any(Object))
    expect(personalApi.post).not.toHaveBeenCalled()
  })
})
