import { describe, expect, it } from 'vitest'
import type { McpClientStatus, ServiceStatus } from './types'
import {
  formatMcpTerminateCountdown,
  formatSeenAgo,
  openSessionAfterRefresh,
  streamMcpLogRef,
} from './mcpSessionFormat'

const NOW = Date.parse('2026-09-11T12:00:00.000Z')

const client = (id: string): McpClientStatus => ({
  id,
  clientName: 'claude-code 2.1.266',
  connectionType: 'stream',
  pid: null,
  startedAt: '2026-09-11T11:59:00.000Z',
  lastSeenAt: '2026-09-11T11:59:52.000Z',
  lastActivityAt: '2026-09-11T11:59:52.000Z',
  terminatesAt: '2026-09-11T12:14:52.000Z',
  terminateSupported: false,
  terminateRequested: false,
})

const service = (fields: Partial<ServiceStatus>): ServiceStatus => ({
  service: 'api',
  name: 'persistent-memory-api',
  id: 'container-api',
  state: 'running',
  status: 'Up 2 hours',
  health: 'healthy',
  controllable: true,
  ...fields,
}) as ServiceStatus

describe('MCP session formatting', () => {
  it('describes how recently a session was seen', () => {
    expect(formatSeenAgo('2026-09-11T11:59:52.000Z', NOW)).toBe('8 s ago')
    expect(formatSeenAgo('2026-09-11T11:56:00.000Z', NOW)).toBe('4 min ago')
    expect(formatSeenAgo('not-a-date', NOW)).toBe('unknown')
  })

  it('counts down to the idle termination', () => {
    expect(formatMcpTerminateCountdown(null, NOW)).toBe('not managed')
    expect(formatMcpTerminateCountdown('2026-09-11T11:59:59.000Z', NOW)).toBe('terminating...')
    expect(formatMcpTerminateCountdown('2026-09-11T12:02:05.000Z', NOW)).toBe('2m 05s')
    expect(formatMcpTerminateCountdown('2026-09-11T13:02:00.000Z', NOW)).toBe('1h 2m')
  })

  it('reads session output from the stream MCP container, never a legacy session row', () => {
    expect(streamMcpLogRef([
      service({ service: 'mcp', id: 'legacy-row', mcpSession: true }),
      service({ service: 'api', id: 'container-api' }),
      service({ service: 'mcp', id: 'container-mcp' }),
    ])).toBe('container-mcp')
    expect(streamMcpLogRef([service({ service: 'mcp', id: '' })])).toBeNull()
  })

  it('closes the open session once its connection leaves the list', () => {
    const clients = [client('stream-a'), client('stream-b')]
    expect(openSessionAfterRefresh(clients, 'stream-a')).toBe('stream-a')
    expect(openSessionAfterRefresh([client('stream-b')], 'stream-a')).toBeNull()
    expect(openSessionAfterRefresh(clients, null)).toBeNull()
  })
})
