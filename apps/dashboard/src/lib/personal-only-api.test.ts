import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'local-session-fixture' }) }) }))

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

describe('personal-only dashboard transport', () => {
  it('ignores old remote connector env and rejects an explicit shared operation before any fetch', async () => {
    vi.stubEnv('PM_SHARED_API_URL', 'https://foreign.example.test')
    vi.stubEnv('PM_SHARED_USER_TOKEN', 'retired-credential')
    vi.stubEnv('PM_MEMORY_INSTALL_MODE', 'shared-only')
    vi.stubEnv('API_URL', 'http://127.0.0.1:8090')
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { api, configuredMemorySurfaces, normalizeMemorySurface } = await import('./api')
    expect(await configuredMemorySurfaces()).toEqual(['personal'])
    expect(() => normalizeMemorySurface('shared')).toThrow('Personal Memories only')
    await expect(api.getOverview('shared')).rejects.toThrow('Personal Memories only')
    expect(fetch).not.toHaveBeenCalled()
    await api.getOverview('personal')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:8090/dashboard/overview')
  })
})
