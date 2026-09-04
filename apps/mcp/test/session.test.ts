import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMcpSession } from '../src/session.ts'

describe('MCP session heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-registers when the API lost its in-memory session registry', async () => {
    vi.useFakeTimers()
    const api = {
      registerMcpSession: vi.fn(async () => ({ ok: true })),
      heartbeatMcpSession: vi.fn(async () => ({ terminate: false, registered: false })),
      closeMcpSession: vi.fn(async () => ({ ok: true })),
    }

    const session = await startMcpSession({
      api: api as never,
      id: 'stream-session-1',
      clientName: 'Codex',
      connectionType: 'stream',
      terminateSupported: false,
    })

    expect(api.registerMcpSession).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(api.heartbeatMcpSession).toHaveBeenCalledWith('stream-session-1')
    expect(api.registerMcpSession).toHaveBeenCalledTimes(2)

    await session.close()
  })
})
