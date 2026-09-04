import { afterEach, describe, expect, it, vi } from 'vitest'
import setupIntegrationTarget from './global-setup.ts'

const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
  vi.unstubAllGlobals()
})

function markProcessForTest(): void {
  process.env.PM_ALLOW_LIVE_INTEGRATION = '1'
  process.env.PM_TEST_STACK = '1'
  process.env.PM_API_BASE = 'http://127.0.0.1:54345'
}

describe('disposable integration target preflight', () => {
  it('rejects before any network traffic unless both explicit process gates are set', async () => {
    process.env.PM_ALLOW_LIVE_INTEGRATION = ''
    process.env.PM_TEST_STACK = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(setupIntegrationTarget()).rejects.toThrow('restricted to the disposable DEV stack')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a normal server that is not marked as a disposable test stack', async () => {
    markProcessForTest()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ deploymentMode: 'server', testStack: false }), { status: 200 })))

    await expect(setupIntegrationTarget()).rejects.toThrow('not the marked server-mode disposable DEV stack')
  })

  it('permits only a marked server-mode disposable stack', async () => {
    markProcessForTest()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ deploymentMode: 'server', testStack: true }), { status: 200 })))

    await expect(setupIntegrationTarget()).resolves.toBeUndefined()
  })
})
