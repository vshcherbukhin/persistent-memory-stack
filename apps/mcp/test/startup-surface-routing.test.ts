import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStartupContext } from '../src/startup.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MCP startup surface routing', () => {
  it('does not inspect or expose a Shared connector in personal-only mode', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://personal.test/config') {
        return new Response(JSON.stringify({
          embeddingMode: 'server',
          activeModel: 'qwen3-embedding:4b',
          activeDim: 2560,
          activeVectorName: 'memory',
          deploymentMode: 'local',
        }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const context = await resolveStartupContext({
      API_URL: 'http://personal.test',
      PM_PERSONAL_API_URL: 'http://personal.test',
      PM_SHARED_API_URL: 'http://shared-leftover.test',
      PM_SHARED_USER_TOKEN: 'legacy-shared-token',
      PM_MEMORY_INSTALL_MODE: 'personal-only',
      // A stale default must not override the installation mode.
      PM_DEFAULT_MEMORY_SURFACE: 'shared',
      PM_API_TIMEOUT_MS: 1_000,
    } as never)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('http://personal.test/config', expect.any(Object))
    expect(context.runtime.memorySurfaces).toMatchObject({ defaultSurface: 'personal' })
    expect(context.runtime.memorySurfaces?.shared).toBeUndefined()
  })

  it('resolves a Shared connector only when personal-and-shared mode is selected', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://personal.test/config') {
        return new Response(JSON.stringify({
          embeddingMode: 'server', activeModel: 'qwen3-embedding:4b', activeDim: 2560,
          activeVectorName: 'memory', deploymentMode: 'local',
        }), { status: 200 })
      }
      if (url === 'http://personal.test/dashboard/shared-connection?includeToken=true') {
        return new Response(JSON.stringify({
          configured: true, apiUrl: 'http://shared.test', tokenConfigured: true, token: 'shared-token',
        }), { status: 200 })
      }
      if (url === 'http://shared.test/config') {
        return new Response(JSON.stringify({
          embeddingMode: 'server', activeModel: 'qwen3-embedding:4b', activeDim: 2560,
          activeVectorName: 'memory', deploymentMode: 'server',
        }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const context = await resolveStartupContext({
      API_URL: 'http://personal.test', PM_PERSONAL_API_URL: 'http://personal.test',
      PM_MEMORY_INSTALL_MODE: 'personal-and-shared', PM_DEFAULT_MEMORY_SURFACE: 'shared',
      PM_API_TIMEOUT_MS: 1_000,
    } as never)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://personal.test/config',
      'http://personal.test/dashboard/shared-connection?includeToken=true',
      'http://shared.test/config',
    ])
    expect(context.runtime.memorySurfaces?.personal).toBeDefined()
    expect(context.runtime.memorySurfaces?.shared).toBeDefined()
  })
})
