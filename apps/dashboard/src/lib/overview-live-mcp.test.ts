import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')

describe('Overview live MCP activity', () => {
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
