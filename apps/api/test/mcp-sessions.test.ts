import { describe, expect, it } from 'vitest'
import {
  closeMcpClient,
  heartbeatMcpClient,
  listMcpClients,
  pruneIdleMcpClients,
  resetMcpClientsForTest,
  terminateMcpClient,
  upsertMcpClient,
} from '../src/services/mcp-sessions.ts'

describe('mcp session registry', () => {
  it('tracks stream and stdio clients without Docker rows', () => {
    resetMcpClientsForTest()

    upsertMcpClient({ id: 'stream-1', clientName: 'Claude Desktop', connectionType: 'stream', terminateSupported: false })
    upsertMcpClient({ id: 'stdio-1', clientName: 'Codex', connectionType: 'stdio', pid: 123, terminateSupported: true })

    expect(listMcpClients().map((client) => [client.id, client.connectionType, client.terminateSupported])).toEqual([
      ['stream-1', 'stream', false],
      ['stdio-1', 'stdio', true],
    ])
  })

  it('marks stdio clients for cooperative termination through heartbeat', () => {
    resetMcpClientsForTest()
    upsertMcpClient({ id: 'stdio-1', clientName: 'Codex', connectionType: 'stdio', pid: 123, terminateSupported: true })

    expect(terminateMcpClient('stdio-1')).toEqual({ ok: true })
    expect(heartbeatMcpClient('stdio-1')).toEqual({ terminate: true, registered: true })
  })

  it('tells clients to re-register when the API registry was reset', () => {
    resetMcpClientsForTest()

    expect(heartbeatMcpClient('stream-1')).toEqual({ terminate: false, registered: false })
  })

  it('does not terminate stream clients through the stdio termination path', () => {
    resetMcpClientsForTest()
    upsertMcpClient({ id: 'stream-1', clientName: 'Claude Desktop', connectionType: 'stream', terminateSupported: false })

    expect(terminateMcpClient('stream-1')).toEqual({ ok: false, reason: 'not_terminable' })
  })

  it('removes clients on close', () => {
    resetMcpClientsForTest()
    upsertMcpClient({ id: 'stdio-1', clientName: 'Codex', connectionType: 'stdio', terminateSupported: true })
    closeMcpClient('stdio-1')
    expect(listMcpClients()).toEqual([])
  })

  it('prunes clients idle beyond the configured timeout', () => {
    resetMcpClientsForTest()
    const now = new Date('2026-07-06T12:15:00.000Z')
    upsertMcpClient({
      id: 'stream-1',
      clientName: 'Codex',
      connectionType: 'stream',
      terminateSupported: false,
      lastActivityAt: new Date(now.getTime() - 900_000).toISOString(),
    })
    upsertMcpClient({
      id: 'stdio-1',
      clientName: 'Legacy',
      connectionType: 'stdio',
      terminateSupported: true,
      lastActivityAt: new Date(now.getTime() - 3_600_000).toISOString(),
    })

    const remaining = pruneIdleMcpClients(900, now)

    expect(remaining).toBe(1)
    expect(listMcpClients().map((client) => client.id)).toEqual(['stdio-1'])
  })

  it('derives stream termination deadlines from last activity and the 15 minute default', () => {
    resetMcpClientsForTest()
    const lastActivityAt = '2026-07-06T12:00:00.000Z'
    upsertMcpClient({
      id: 'stream-1',
      clientName: 'Codex',
      connectionType: 'stream',
      terminateSupported: false,
      lastActivityAt,
    })

    expect(listMcpClients()[0]).toMatchObject({
      id: 'stream-1',
      lastActivityAt,
      terminatesAt: '2026-07-06T12:15:00.000Z',
    })
  })
})
