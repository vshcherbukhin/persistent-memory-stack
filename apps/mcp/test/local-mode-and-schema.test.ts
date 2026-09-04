import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { ApiClient } from '../src/api-client.ts'
import { registerIdentityTools } from '../src/tools/identity.ts'
import { registerMemoryTools, selectMemoryContext } from '../src/tools/memories.ts'
import { registerGraphTools } from '../src/tools/graph.ts'
import { registerDocumentTools } from '../src/tools/documents.ts'
import type { Runtime } from '../src/runtime.ts'

type Tool = {
  options: { inputSchema?: z.ZodRawShape; outputSchema?: z.ZodRawShape }
  handler: (input: Record<string, unknown>) => Promise<{
    content?: { type: 'text'; text: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }>
}

function collectTools(register: (server: unknown) => void): Map<string, Tool> {
  const tools = new Map<string, Tool>()
  const server = {
    registerTool(name: string, options: Tool['options'], handler: Tool['handler']) {
      tools.set(name, { options, handler })
    },
  }
  register(server)
  return tools
}

async function expectStructuredContentMatches(tool: Tool, input: Record<string, unknown> = {}): Promise<void> {
  const result = await tool.handler(input)
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toBeDefined()
  z.object(tool.options.outputSchema!).strict().parse(result.structuredContent)
}

const runtime: Runtime = {
  mode: 'server',
  deploymentMode: 'local',
  pin: { modelId: 'qwen3-embedding:4b', dim: 2560 },
  bridge: null,
}

const EXAMPLE_USER_ID = '94ad7cf6-ef23-45c8-b67c-3ab4652dbfc0'
const EXAMPLE_TEAM_ID = '8b96adbb-35d5-48b8-9b33-39c70f3f88cb'
const EXAMPLE_DOC_ID = '45aa4c15-e30d-4059-83ce-08284d2f8795'
const EXAMPLE_TEAM_NAME = 'Example Memory Team'
const EXAMPLE_USER_NAME = 'Example Engineer'
const EXAMPLE_USER_EMAIL = 'engineer@example.test'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local-mode MCP auth', () => {
  it('omits Authorization when PM_USER_TOKEN is absent for public/local-mode startup calls', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ApiClient({ API_URL: 'http://localhost:8090', PM_API_TIMEOUT_MS: 1000 } as never)

    await api.get('/config')

    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.authorization).toBeUndefined()
  })

  it('personal-only MCP tools advertise only the Personal Memories surface', async () => {
    const personalOnlyRuntime: Runtime = {
      ...runtime,
      memorySurfaces: {
        defaultSurface: 'personal',
        personal: { api: {} as never, runtime },
      },
    }
    const memories = collectTools((server) => registerMemoryTools(server as never, {
      api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), del: vi.fn(), delNoContent: vi.fn() },
      runtime: personalOnlyRuntime,
    } as never))
    const graph = collectTools((server) => registerGraphTools(server as never, {
      api: { post: vi.fn(), get: vi.fn() },
      runtime: personalOnlyRuntime,
    } as never))

    for (const tool of [
      ...['add_memory', 'search_memories', 'search_memories_by_entities', 'get_memories'].map((name) => memories.get(name)),
      ...['search_graph', 'get_entity', 'get_timeline', 'get_contradictions'].map((name) => graph.get(name)),
    ]) {
      const surface = tool?.options.inputSchema?.surface
      expect(surface).toBeDefined()
      expect(z.object({ surface: surface! }).safeParse({ surface: 'personal' }).success).toBe(true)
      expect(z.object({ surface: surface! }).safeParse({ surface: 'shared' }).success).toBe(false)
    }

    await expect(selectMemoryContext(
      {} as never,
      {} as never,
      personalOnlyRuntime,
      'shared',
      'named-project',
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('not configured') })
  })

  it('returns actionable contract recovery instead of schema-invalid graph output from every graph read tool', async () => {
    const untaggedFact = { uuid: 'fact-missing-provenance' }
    const api = {
      post: vi.fn(async () => ({ facts: [untaggedFact] })),
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/graph/entity/')) return { name: 'entity', facts: [untaggedFact] }
        if (path === '/graph/timeline') return { entityUuid: null, entries: [untaggedFact] }
        if (path === '/graph/contradictions') return { contradictions: [{ superseded: untaggedFact, superseded_by: null }] }
        throw new Error(`unexpected GET ${path}`)
      }),
    }
    const graph = collectTools((server) => registerGraphTools(server as never, { api, runtime } as never))
    const calls: Array<[string, Record<string, unknown>]> = [
      ['search_graph', { query: 'entity' }],
      ['get_entity', { name: 'entity' }],
      ['get_timeline', {}],
      ['get_contradictions', {}],
    ]

    for (const [name, input] of calls) {
      const result = await graph.get(name)!.handler(input)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      expect(result.content?.[0]?.text).toContain('graph_response_contract_invalid')
      expect(result.content?.[0]?.text).toContain('Retry the same')
    }
  })

  it('fails closed when a contradiction pair itself is malformed', async () => {
    const api = {
      get: vi.fn(async () => ({ contradictions: [{}] })),
    }
    const graph = collectTools((server) => registerGraphTools(server as never, { api, runtime } as never))

    const result = await graph.get('get_contradictions')!.handler({})

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content?.[0]?.text).toContain('graph_response_contract_invalid')
  })

  it('routes memory reads and writes through the selected memory surface', async () => {
    const personalApi = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/project-memory-bindings/')) {
          return { project: path.split('/').at(-1), surface: path.endsWith('shared-project') ? 'shared' : 'personal' }
        }
        throw new Error(`unexpected personal GET ${path}`)
      }),
      post: vi.fn(async () => ({
        id: 'mem-personal',
        shape: 'atomic',
        category: 'note',
        project: 'persistent-memory',
        restructured: false,
        content: 'personal memory',
        embeddingStatus: 'embedded',
        memoryTier: 'semantic',
        sourceProvenance: 'user_direct',
        confidence: 1,
      })),
    }
    const sharedApi = {
      get: vi.fn(),
      post: vi.fn(async () => ({ results: [], counts: { own: 0, other: 0 } })),
    }
    const memories = collectTools((server) => registerMemoryTools(server as never, {
      api: sharedApi,
      runtime: {
        ...runtime,
        memorySurfaces: {
          defaultSurface: 'personal',
          personal: { api: personalApi, runtime },
          shared: { api: sharedApi, runtime },
        },
      },
    } as never))

    await memories.get('add_memory')!.handler({
      content: '[component_Test] personal memory routing should store locally. Root cause: explicit surface selection. Fix: use personal API.',
      project: 'persistent-memory',
      metadata: { category: 'note', entities: ['component_Test'], source: 'manual' },
    })
    await memories.get('search_memories')!.handler({ query: 'routing', surface: 'shared', project: 'shared-project', limit: 20 })

    expect(personalApi.post).toHaveBeenCalledWith('/memories', expect.objectContaining({ project: 'persistent-memory' }))
    expect(sharedApi.post).toHaveBeenCalledWith('/memories/search', expect.objectContaining({ query: 'routing' }))
  })

  it('honors explicit Shared routing for collection and id-based memory tools', async () => {
    const personalApi = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/project-memory-bindings/')) return { project: 'shared-project', surface: 'shared' }
        throw new Error(`unexpected personal GET ${path}`)
      }),
    }
    const sharedApi = {
      get: vi.fn(async (path: string) => {
        if (path === '/memories') return { results: [], nextCursor: null }
        if (path === '/entities') return { entities: [] }
        if (path.startsWith('/memories/')) return { id: 'memory-id', project: 'shared-project', category: 'note' }
        throw new Error(`unexpected shared GET ${path}`)
      }),
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search-by-entities') return { results: [] }
        throw new Error(`unexpected shared POST ${path}`)
      }),
      patch: vi.fn(async () => ({ id: 'memory-id', restructured: false })),
      delNoContent: vi.fn(async () => undefined),
      del: vi.fn(async () => ({ deleted: 1 })),
    }
    const sharedRuntime: Runtime = {
      ...runtime,
      memorySurfaces: {
        defaultSurface: 'personal',
        personal: { api: personalApi, runtime },
        shared: { api: sharedApi, runtime },
      },
    }
    const memories = collectTools((server) => registerMemoryTools(server as never, {
      api: personalApi,
      runtime: sharedRuntime,
    } as never))

    await expect(selectMemoryContext({} as never, personalApi as never, sharedRuntime, 'shared')).resolves.toMatchObject({ ok: true, api: sharedApi, surface: 'shared' })
    await memories.get('search_memories_by_entities')!.handler({ surface: 'shared', entities: ['component_Test'], project: 'shared-project' })
    await memories.get('get_memories')!.handler({ surface: 'shared', project: 'shared-project' })
    await memories.get('get_memory')!.handler({ surface: 'shared', id: 'memory-id' })
    await memories.get('update_memory')!.handler({ surface: 'shared', id: 'memory-id', content: 'Updated shared memory content is long enough to satisfy the memory shape gate.' })
    await memories.get('delete_memory')!.handler({ surface: 'shared', id: 'memory-id' })
    await memories.get('delete_all_memories')!.handler({ surface: 'shared', project: 'shared-project', confirm: true })
    await memories.get('list_entities')!.handler({ surface: 'shared', project: 'shared-project' })

    expect(sharedApi.post).toHaveBeenCalledWith('/memories/search-by-entities', expect.objectContaining({ entities: ['component_Test'] }))
    expect(sharedApi.get).toHaveBeenCalledWith('/memories', expect.objectContaining({ project: 'shared-project' }))
    expect(sharedApi.get).toHaveBeenCalledWith('/memories/memory-id')
    expect(sharedApi.patch).toHaveBeenCalledWith('/memories/memory-id', expect.objectContaining({ content: expect.any(String) }))
    expect(sharedApi.delNoContent).toHaveBeenCalledWith('/memories/memory-id')
    expect(sharedApi.del).toHaveBeenCalledWith('/memories', expect.objectContaining({ project: 'shared-project', confirm: true }))
    expect(sharedApi.get).toHaveBeenCalledWith('/entities', expect.objectContaining({ project: 'shared-project' }))
  })
})

describe('MCP structuredContent matches declared outputSchema', () => {
  it('validates the previously drift-prone tool results', async () => {
    const memoryRow = {
      id: 'mem-1',
      content: 'A remembered fact',
      category: 'fix',
      shape: 'A',
      entities: ['component_installer'],
      project: 'persistent-memory',
      sessionId: null,
      createdById: 'user-1',
      score: 0.9,
      sourceTeam: 'team-1',
      isOwnTeam: true,
      createdAt: '2026-06-30T00:00:00.000Z',
      recordUpdatedAt: '2026-06-30T00:00:00.000Z',
      memoryTier: 'semantic',
      sourceProvenance: 'user-correction',
      confidence: 0.95,
    }
    const chunkHit = {
      documentId: EXAMPLE_DOC_ID,
      chunkId: 'chunk-1',
      ordinal: 0,
      content: 'psql should not be required on the host',
      project: 'persistent-memory',
      sourceTeam: 'team-1',
      isOwnTeam: true,
      score: 0.8,
    }
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === '/whoami') {
          return {
            userId: 'user-1',
            teamId: 'team-1',
            adminLevel: 'superuser',
            isTeamMember: true,
            isTeamAdmin: true,
            isGlobalSuperuser: true,
            mountedTeams: [],
            deploymentMode: 'local',
            teamName: EXAMPLE_TEAM_NAME,
            userDisplayName: EXAMPLE_USER_NAME,
            userEmail: EXAMPLE_USER_EMAIL,
            futureApiField: 'must not leak into structuredContent',
          }
        }
        if (path.startsWith('/documents/')) {
          return {
            id: EXAMPLE_DOC_ID,
            title: 'Install notes',
            filename: 'install.md',
            versionNumber: 2,
            mimeType: 'text/markdown',
            project: 'persistent-memory',
            sourceTeam: 'team-1',
            isOwnTeam: true,
            originalUrl: 'https://minio.example/presigned',
            originalUrlExpiresAt: '2026-06-30T01:00:00.000Z',
            createdAt: '2026-06-30T00:00:00.000Z',
          }
        }
        throw new Error(`unexpected GET ${path}`)
      }),
      post: vi.fn(async (path: string) => {
        if (path === '/memories/search') return { results: [memoryRow], counts: { own: 1, other: 0 } }
        if (path === '/documents/search') return { results: [chunkHit], counts: { own: 1, other: 0 } }
        throw new Error(`unexpected POST ${path}`)
      }),
    }

    const identity = collectTools((server) => registerIdentityTools(server as never, { api, runtime } as never))
    const memories = collectTools((server) => registerMemoryTools(server as never, { api, runtime } as never))
    const documents = collectTools((server) => registerDocumentTools(server as never, { api, runtime } as never))

    await expectStructuredContentMatches(identity.get('whoami')!)
    await expectStructuredContentMatches(memories.get('search_memories')!, { query: 'installer', limit: 20 })
    await expectStructuredContentMatches(documents.get('search_documents')!, { query: 'installer', limit: 20 })
    await expectStructuredContentMatches(documents.get('get_document')!, { id: EXAMPLE_DOC_ID })
  })

  it('identity tools expose human local identity fields in text and structured content', async () => {
    const api = {
      get: vi.fn(async () => ({
        userId: EXAMPLE_USER_ID,
        teamId: EXAMPLE_TEAM_ID,
        teamName: EXAMPLE_TEAM_NAME,
        userDisplayName: EXAMPLE_USER_NAME,
        userEmail: EXAMPLE_USER_EMAIL,
        adminLevel: 'superuser',
        isTeamMember: true,
        isTeamAdmin: false,
        isGlobalSuperuser: true,
        mountedTeams: [],
        deploymentMode: 'local',
      })),
    }
    const identity = collectTools((server) => registerIdentityTools(server as never, { api, runtime } as never))

    const result = await identity.get('whoami')!.handler({})
    const readableTeams = await identity.get('list_readable_teams')!.handler({})

    expect(result.structuredContent).toMatchObject({
      userDisplayName: EXAMPLE_USER_NAME,
      userEmail: EXAMPLE_USER_EMAIL,
      teamName: EXAMPLE_TEAM_NAME,
    })
    expect(JSON.stringify(result)).toContain(EXAMPLE_USER_NAME)
    expect(JSON.stringify(result)).toContain(EXAMPLE_TEAM_NAME)
    expect(JSON.stringify(readableTeams)).toContain('personal memories in this local stack')
    expect(JSON.stringify(readableTeams)).not.toContain(EXAMPLE_TEAM_NAME)
    expect(readableTeams.structuredContent).toEqual({
      ownTeam: EXAMPLE_TEAM_ID,
      mountedTeams: [],
    })
  })
})
