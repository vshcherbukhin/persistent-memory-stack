import { describe, expect, it, vi } from 'vitest'
import { registerMemoryTools } from '../src/tools/memories.ts'
import type { Runtime } from '../src/runtime.ts'

describe('project memory-surface binding', () => {
  it('elicits and persists the first named-project choice before writing', async () => {
    const personalApi = {
      get: vi.fn(async () => ({ project: 'alpha', surface: null })),
      post: vi.fn(async (path: string) => {
        if (path === '/project-memory-bindings') return { project: 'alpha', surface: 'shared' }
        throw new Error(`unexpected personal POST ${path}`)
      }),
    }
    const sharedApi = {
      post: vi.fn(async (path: string) => {
        if (path === '/memories') {
          return {
            id: 'memory-1', shape: 'atomic', category: 'fix', project: 'alpha',
            restructured: false, content: 'stored', embeddingStatus: 'embedded',
            memoryTier: 'semantic', sourceProvenance: 'user_direct', confidence: 1,
          }
        }
        throw new Error(`unexpected shared POST ${path}`)
      }),
    }
    const base: Runtime = {
      mode: 'server', deploymentMode: 'local', pin: { modelId: 'test', dim: 1 }, bridge: null,
    }
    const runtime: Runtime = {
      ...base,
      memorySurfaces: {
        defaultSurface: 'personal',
        personal: { api: personalApi as never, runtime: base },
        shared: { api: sharedApi as never, runtime: base },
      },
    }
    const tools = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
    const elicitInput = vi.fn(async () => ({ action: 'accept', content: { surface: 'shared' } }))
    const server = {
      server: { elicitInput },
      registerTool(name: string, _options: unknown, handler: (input: Record<string, unknown>) => Promise<unknown>) {
        tools.set(name, handler)
      },
    }
    registerMemoryTools(server as never, { api: personalApi, runtime } as never)

    await tools.get('add_memory')!({
      content: '[component_alpha] The project binding was selected by the user. Fix: store it before the first memory write.',
      project: 'alpha',
      metadata: { category: 'fix', entities: ['component_alpha'], source: 'user-correction' },
    })

    expect(elicitInput).toHaveBeenCalledOnce()
    expect(personalApi.post).toHaveBeenCalledWith('/project-memory-bindings', { project: 'alpha', surface: 'shared' })
    expect(sharedApi.post).toHaveBeenCalledWith('/memories', expect.objectContaining({ project: 'alpha' }))
  })
})
