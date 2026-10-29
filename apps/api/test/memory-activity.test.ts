import Fastify from 'fastify'
import { request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryActivity, memoryOperation, registerMemoryRuntime } from '../src/services/memory-activity.ts'
import { EmbeddingsNotReadyError } from '../src/services/ollama-readiness.ts'

const owner = { teamId: 'team-a', userId: 'owner-a' }
describe('private memory activity and startup gate', () => {
  it('classifies route templates without storing queries and excludes its own polling', () => {
    expect(memoryOperation('POST', '/memories/search')).toBe('read')
    expect(memoryOperation('POST', '/memories/search-by-entities')).toBe('read')
    expect(memoryOperation('POST', '/dashboard/memories/bulk-delete-preview')).toBe('read')
    expect(memoryOperation('POST', '/dashboard/memories/graph/rebuild')).toBe('update')
    expect(memoryOperation('GET', '/graph/entity/:name')).toBe('read')
    expect(memoryOperation('POST', '/dashboard/memories')).toBe('write')
    expect(memoryOperation('PATCH', '/admin/memories/:id')).toBe('update')
    expect(memoryOperation('GET', '/dashboard/memory-activity')).toBeNull()
    expect(memoryOperation('GET', '/memories/pending-embeddings')).toBeNull()
  })
  it('keeps only SQL Overview feeds readable during launch and still blocks search and writes', async () => {
    const app = Fastify(), activity = createMemoryActivity()
    const ensure = vi.fn(async () => { throw new EmbeddingsNotReadyError({ state: 'starting', message: 'Still launching.', observedAt: new Date(), readyAt: null }) })
    app.addHook('onRequest', (req, _reply, done) => { req.identity = owner as typeof req.identity; done() })
    app.setErrorHandler((_err, _req, reply) => reply.code(503).send({ error: 'embeddings_starting' }))
    registerMemoryRuntime(app, ensure, activity)
    for (const route of ['/dashboard/memories', '/dashboard/memories/pending', '/graph/facets']) app.get(route, async () => ({ available: true }))
    app.post('/dashboard/memories/search', async () => ({ result: 'must not run' }))
    app.post('/memories', async () => ({ saved: true }))
    try {
      for (const route of ['/dashboard/memories', '/dashboard/memories/pending', '/graph/facets']) expect((await app.inject({ method: 'GET', url: route })).statusCode).toBe(200)
      expect(ensure).not.toHaveBeenCalled()
      expect(activity.snapshot(owner).read.state).toBe('success')
      expect((await app.inject({ method: 'POST', url: '/dashboard/memories/search', payload: {} })).statusCode).toBe(503)
      expect((await app.inject({ method: 'POST', url: '/memories', payload: {} })).statusCode).toBe(503)
      expect(ensure).toHaveBeenCalledTimes(2)
    } finally { await app.close() }
  })
  it('clears active when the caller disconnects after its full body was received', async () => {
    const app = Fastify(), activity = createMemoryActivity()
    let started!: () => void, complete!: () => void
    const handlerStarted = new Promise<void>(resolve => { started = resolve })
    const handlerCanFinish = new Promise<void>(resolve => { complete = resolve })
    app.addHook('onRequest', (req, _reply, done) => { req.identity = owner as typeof req.identity; done() })
    registerMemoryRuntime(app, async () => {}, activity)
    app.post('/memories', async () => { started(); await handlerCanFinish; return { saved: true } })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as { port: number }
    const client = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/memories', method: 'POST', headers: { 'content-type': 'application/json' } })
    client.on('error', () => {})
    try {
      client.end('{"synthetic":true}')
      await handlerStarted
      expect(activity.snapshot(owner).write).toMatchObject({ active: 1, state: 'active' })
      client.destroy()
      await vi.waitFor(() => expect(activity.snapshot(owner).write).toMatchObject({ active: 0, state: 'error' }))
      complete()
      expect(activity.snapshot(owner).write.active).toBe(0)
    } finally { complete(); client.destroy(); await app.close() }
  })
  it('tracks overlapping requests, scopes by validated owner, expires pulses and finishes only once', () => {
    let time = 1000
    const activity = createMemoryActivity(() => time)
    const first = activity.begin(owner, 'read'), second = activity.begin(owner, 'read')
    expect(activity.snapshot(owner).read).toMatchObject({ active: 2, state: 'active' })
    first('success'); first('error')
    expect(activity.snapshot(owner).read.active).toBe(1)
    expect(activity.snapshot({ ...owner, userId: 'another' }).read.state).toBe('idle')
    expect(activity.snapshot({ ...owner, teamId: 'another' }).read.state).toBe('idle')
    second('error')
    expect(activity.snapshot(owner).read).toMatchObject({ active: 0, state: 'error' })
    time += 8001
    expect(activity.snapshot(owner).read.state).toBe('idle')
  })
  it('fails before a handler can save or validate, then recovers without replaying the failed request', async () => {
    const app = Fastify()
    const activity = createMemoryActivity()
    let ready = false
    const handler = vi.fn(async () => ({ saved: true }))
    app.addHook('onRequest', (req, _reply, done) => { req.identity = owner as typeof req.identity; done() })
    app.setErrorHandler((error, _req, reply) => reply.code(503).send({ error: (error as EmbeddingsNotReadyError).code, message: error.message, retryable: true }))
    registerMemoryRuntime(app, async () => { if (!ready) throw new EmbeddingsNotReadyError({ state: 'starting', message: 'Embeddings service is still launching. Please try again shortly.', observedAt: new Date(), readyAt: null }) }, activity)
    app.post('/memories', handler)
    try {
      const response = await app.inject({ method: 'POST', url: '/memories', payload: { content: 'synthetic' } })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ error: 'embeddings_starting', retryable: true })
      expect(handler).not.toHaveBeenCalled()
      expect(activity.snapshot(owner).write.state).toBe('starting')
      ready = true
      expect((await app.inject({ method: 'POST', url: '/memories', payload: {} })).statusCode).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(activity.snapshot(owner).write.state).toBe('success')
    } finally { await app.close() }
  })
})
