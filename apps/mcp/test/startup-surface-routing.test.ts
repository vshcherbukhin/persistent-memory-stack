import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStartupContext } from '../src/startup.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MCP startup surface routing', () => {
  it('does not inspect or expose a Shared connector in personal-only mode', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:18090/config') {
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
      API_URL: 'http://127.0.0.1:18090',
      PM_PERSONAL_API_URL: 'http://127.0.0.1:18090',
      PM_SHARED_API_URL: 'http://shared-leftover.test',
      PM_SHARED_USER_TOKEN: 'legacy-shared-token',
      PM_MEMORY_INSTALL_MODE: 'personal-only',
      // A stale default must not override the installation mode.
      PM_DEFAULT_MEMORY_SURFACE: 'shared',
      PM_API_TIMEOUT_MS: 1_000,
    } as never)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18090/config', expect.any(Object))
    expect(context.runtime.deploymentMode).toBe('local')
    expect(context.runtime.memorySurfaces).toBeUndefined()
    expect(context.runtime.memorySurfaces?.shared).toBeUndefined()
  })

  it('keeps old personal-and-shared configuration inert', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:18090/config') {
        return new Response(JSON.stringify({
          embeddingMode: 'server', activeModel: 'qwen3-embedding:4b', activeDim: 2560,
          activeVectorName: 'memory', deploymentMode: 'local',
        }), { status: 200 })
      }
      if (url === 'http://127.0.0.1:18090/dashboard/shared-connection?includeToken=true') {
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
      API_URL: 'http://127.0.0.1:18090', PM_PERSONAL_API_URL: 'http://127.0.0.1:18090',
      PM_MEMORY_INSTALL_MODE: 'personal-and-shared', PM_DEFAULT_MEMORY_SURFACE: 'shared',
      PM_API_TIMEOUT_MS: 1_000,
    } as never)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:18090/config',
    ])
    expect(context.runtime.memorySurfaces).toBeUndefined()
  })
  it('rejects retired remote/shared-only endpoints before contacting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveStartupContext({ API_URL: 'https://foreign-memory.example', PM_MEMORY_INSTALL_MODE: 'personal-only' } as never)).rejects.toThrow('local personal API')
    await expect(resolveStartupContext({ API_URL: 'http://127.0.0.1:18090', PM_MEMORY_INSTALL_MODE: 'shared-only' } as never)).rejects.toThrow('Shared-only operation is retired')
    expect(fetchMock).not.toHaveBeenCalled()
  })

})
