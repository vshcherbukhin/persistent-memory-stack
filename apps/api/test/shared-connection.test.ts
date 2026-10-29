import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@pm/shared', async original => ({ ...await original<typeof import('@pm/shared')>(), makeScheduledQueue: vi.fn(() => ({})), makeMemoryGraphRebuildQueue: vi.fn(() => ({})) }))
vi.mock('../src/services/queue.ts', () => ({ ingestQueue: {} }))
vi.mock('../src/auth/authenticate.ts', () => ({ authenticate: async () => {}, authenticateLocal: async () => {}, enterTenantScope: (_req: unknown, _reply: unknown, done: () => void) => done() }))
import { buildApp } from '../src/app.ts'
afterEach(() => vi.unstubAllGlobals())

describe('retired sharing reachability', () => {
  it.each(['/dashboard/shared-connection', '/admin/shared-connection', '/dashboard/shared-connection/test', '/admin/shared-connection/test', '/dashboard/grants', '/admin/grants'])('does not register or execute connector/grant operations at %s', async url => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const app = buildApp()
    try {
      await app.ready()
      for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
        expect(app.hasRoute({ method, url })).toBe(false)
        const result = await app.inject({ method, url, ...(method === 'POST' || method === 'PUT' ? { payload: { apiUrl: 'https://foreign.example.test', token: 'retired-token', ownerId: 'forged-owner' } } : {}) })
        expect(result.statusCode, result.body).toBe(404)
      }
      expect(fetch).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
})
