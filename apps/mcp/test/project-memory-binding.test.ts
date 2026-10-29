import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerMemoryTools } from '../src/tools/memories.ts'
import type { Runtime } from '../src/runtime.ts'

describe('retired project memory-surface bindings', () => {
  it('stores classified knowledge with the validated personal API without eliciting or reading an old project binding', async () => {
    const personalApi = { get: vi.fn(), post: vi.fn(async () => ({ id: 'memory-1', revision: 1 })) }
    const sharedApi = { post: vi.fn() }
    const base: Runtime = { mode: 'server', deploymentMode: 'local', pin: { modelId: 'test', dim: 1 }, bridge: null }
    const runtime: Runtime = { ...base, memorySurfaces: { defaultSurface: 'personal', personal: { api: personalApi as never, runtime: base }, shared: { api: sharedApi as never, runtime: base } } }
    const tools = new Map<string, { schema: z.ZodRawShape; handler: (input: unknown) => Promise<unknown> }>()
    const elicitInput = vi.fn()
    const server = { server: { elicitInput }, registerTool(name: string, options: { inputSchema: z.ZodRawShape }, handler: (input: unknown) => Promise<unknown>) { tools.set(name, { schema: options.inputSchema, handler }) } }
    registerMemoryTools(server as never, { api: personalApi, runtime } as never)
    const write = { contractVersion: 2, content: 'The synthetic owner proposed a focused retrieval evaluation before adoption.', classification: {
      memoryType: 'decision', assertionStatus: 'proposal', primaryTopic: 'memory-retrieval', topicTags: ['memory-retrieval'],
      origin: { kind: 'project', name: 'alpha' }, applicability: { state: 'associated', projects: ['alpha', 'beta'] },
      sources: [{ kind: 'user', reference: 'conversation:fixture', evidence: 'The owner explicitly proposed evaluation; adoption was not decided.' }],
    }, idempotencyKey: 'fixture-operation-1' }
    const add = tools.get('add_memory')!
    await add.handler(z.object(add.schema).parse(write))
    expect(personalApi.post).toHaveBeenCalledWith('/memories', write)
    expect(personalApi.get).not.toHaveBeenCalled()
    expect(sharedApi.post).not.toHaveBeenCalled()
    expect(elicitInput).not.toHaveBeenCalled()
  })
})
