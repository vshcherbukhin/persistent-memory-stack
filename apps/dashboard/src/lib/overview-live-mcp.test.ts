import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { McpLiveSessionsPanel } from '../app/(dashboard)/McpLiveSessionsPanel'
import type { McpClientStatus } from './types'

vi.mock('../app/(dashboard)/services/actions', () => ({ listServicesAction: vi.fn(), serviceLogsAction: vi.fn() }))

const source = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')

describe('Overview live MCP activity', () => {
  it('renders the same initial live-session markup across time zones and clock drift', () => {
    const originalZone = process.env.TZ
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'))
    const session: McpClientStatus = { id: 'synthetic-stream', clientName: 'Synthetic client', connectionType: 'stream', pid: null, startedAt: '2026-09-11T11:59:00.000Z', lastSeenAt: '2026-09-11T11:59:52.000Z', lastActivityAt: '2026-09-11T11:59:52.000Z', terminatesAt: '2026-09-11T12:14:52.000Z', terminateSupported: false, terminateRequested: false }
    try {
      process.env.TZ = 'UTC'
      const server = renderToString(createElement(McpLiveSessionsPanel, { initialClients: [session], initialLogRef: null }))
      process.env.TZ = 'America/Toronto'
      vi.setSystemTime(new Date('2026-09-11T12:00:08.000Z'))
      const browser = renderToString(createElement(McpLiveSessionsPanel, { initialClients: [session], initialLogRef: null }))
      expect(browser).toBe(server)
    } finally {
      if (originalZone === undefined) delete process.env.TZ
      else process.env.TZ = originalZone
      vi.useRealTimers()
    }
  })
  it('replaces the cursorless graph activity read with the live MCP session panel', () => {
    const overview = source('../app/(dashboard)/page.tsx')

    expect(overview).toContain('<McpLiveSessionsPanel initialClients={liveClients} initialLogRef={liveLogRef} initialError={liveError} />')
    expect(overview).toContain('api.listServices()')
    expect(overview).not.toContain('getMemoryGraphActivity')
    expect(overview).not.toContain('MemoryActivityPanel')
  })

  it('polls sessions, opens a row in place and returns to the list when its connection closes', () => {
    const panel = source('../app/(dashboard)/McpLiveSessionsPanel.tsx')

    expect(panel).toContain('await listServicesAction()')
    expect(panel).toContain('filterMcpSessionLogs(result.logs, sessionId)')
    expect(panel).toContain('openSessionAfterRefresh(clients, open.id)')
    expect(panel).toContain('className="gt-row mcp-live-row"')
    expect(panel).toContain('All sessions')
    expect(panel).not.toContain(' title=')
  })
})
