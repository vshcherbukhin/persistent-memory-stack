import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ lexical: vi.fn(async () => []), run: vi.fn(), rows: vi.fn(async () => []), count: vi.fn(async () => 0) }))
const identity = { userId: '11111111-1111-4111-8111-111111111111', teamId: '22222222-2222-4222-8222-222222222222', adminLevel: 'superuser' as const, isTeamMember: true, isTeamAdmin: false, isGlobalSuperuser: true, mountedTeamIds: [], insideTenantTx: false }
vi.mock('@pm/db', async original => ({ ...await original<typeof import('@pm/db')>(), getCtx: () => identity, runInTenant: (...args: unknown[]) => h.run(...args) }))
vi.mock('../src/services/embedding.ts', () => ({ embedder: null, qdrant: {}, activePin: { modelId: 'fixture', dim: 1, vectorName: 'fixture' } }))
import { memoryRoutes } from '../src/routes/memories.ts'
import { knowledgeWhere } from '../src/services/knowledge.ts'

async function appFixture() {
  h.run.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ memory: { findMany: h.rows, count: h.count }, $queryRaw: h.lexical }))
  const app = Fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
  app.addHook('onRequest', (req, _reply, done) => { req.identity = identity; done() })
  app.setErrorHandler((error: { statusCode?: number; message: string }, _request, reply) => reply.code(error.statusCode ?? 500).send({ error: error.message }))
  await app.register(memoryRoutes); await app.ready(); return app
}
afterEach(() => vi.clearAllMocks())

describe('strict relational memory filters', () => {
  it.each([
    { project: 'alpha', projects: ['beta'] },
    { createdAfter: '2026-10-02T00:00:00.000Z', createdBefore: '2026-10-01T00:00:00.000Z' },
    { project: '' },
  ])('rejects conflicting/empty filters before semantic or lexical work: %j', async filters => {
    const app = await appFixture()
    try {
      const result = await app.inject({ method: 'POST', url: '/memories/search', payload: { query: 'synthetic concept', ...filters } })
      expect([400, 422], result.body).toContain(result.statusCode)
      expect(h.run).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
  it('rejects an explicitly empty project list query instead of broadening it', async () => {
    const app = await appFixture()
    try {
      const result = await app.inject({ method: 'GET', url: '/memories?project=' })
      expect([400, 422], result.body).toContain(result.statusCode)
      expect(h.run).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
  it('keeps an explicit filter after zero matches while relevance hints stay separate', async () => {
    const app = await appFixture()
    try {
      const result = await app.inject({ method: 'POST', url: '/memories/search', payload: { query: 'synthetic concept', project: 'alpha', contextHints: { projects: ['beta'] } } })
      expect(result.statusCode, result.body).toBe(200)
      expect(h.run).toHaveBeenCalledOnce()
      expect(h.lexical).toHaveBeenCalledOnce()
      expect(knowledgeWhere({ project: 'alpha', contextHints: { projects: ['beta'] } } as never)).toMatchObject({ OR: [{ projectAssociations: { hasSome: ['alpha'] } }, { project: { in: ['alpha'] } }] })
      expect(result.json().results).toEqual([])
    } finally { await app.close() }
  })
})
