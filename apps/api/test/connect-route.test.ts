import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@pm/shared', async original => ({ ...await original<typeof import('@pm/shared')>(), makeScheduledQueue: vi.fn(() => ({})), makeMemoryGraphRebuildQueue: vi.fn(() => ({})) }))
vi.mock('../src/services/queue.ts', () => ({ ingestQueue: {} }))
vi.mock('../src/auth/authenticate.ts', () => ({ authenticate: async () => {}, authenticateLocal: async () => {}, enterTenantScope: (_req: unknown, _reply: unknown, done: () => void) => done() }))
import { buildApp } from '../src/app.ts'
afterEach(() => vi.unstubAllGlobals())

describe('retired connector registration and project-surface bindings', () => {
  it.each(['/connect/local-dashboard/token', '/project-memory-bindings', '/project-memory-bindings/alpha'])('cannot mint access or activate sharing through %s', async url => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const app = buildApp()
    try {
      await app.ready()
      for (const method of ['GET', 'POST', 'PUT'] as const) {
        expect(app.hasRoute({ method, url })).toBe(false)
        const result = await app.inject({ method, url, ...(method !== 'GET' ? { payload: { project: 'alpha', surface: 'shared', teamId: 'forged-team' } } : {}) })
        expect(result.statusCode, result.body).toBe(404)
      }
      expect(fetch).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
})
