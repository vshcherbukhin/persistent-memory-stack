'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { LogOutput } from '@/components/LogOutput'
import { Icon } from '@/components/ui/Icon'
import { filterMcpSessionLogs } from '@/lib/logFormat'
import {
  formatMcpTerminateCountdown,
  formatMcpTerminateTime,
  formatSeenAgo,
  openSessionAfterRefresh,
  streamMcpLogRef,
} from '@/lib/mcpSessionFormat'
import type { McpClientStatus } from '@/lib/types'
import { listServicesAction, serviceLogsAction } from './services/actions'

const LIST_POLL_MS = 5_000
const OUTPUT_POLL_MS = 3_000
const OUTPUT_TAIL_LINES = 400
const MCP_LIVE_COLS = 'minmax(0, 1fr) 132px 104px 128px 32px'

type OpenSession = { id: string; name: string }

/**
 * Overview live MCP activity: the stream connections the MCP service holds right now.
 * A session leaves the list as soon as its connection closes; selecting a row swaps the
 * list for that session's live communication, with a way back to the list.
 */
export function McpLiveSessionsPanel({
  initialClients,
  initialLogRef,
  initialError,
}: {
  initialClients: McpClientStatus[]
  initialLogRef: string | null
  initialError?: string
}) {
  const [clients, setClients] = useState<McpClientStatus[]>(initialClients)
  const [logRef, setLogRef] = useState<string | null>(initialLogRef)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [open, setOpen] = useState<OpenSession | null>(null)
  const [endedName, setEndedName] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [outputError, setOutputError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const listInFlight = useRef(false)

  const refreshList = useCallback(async () => {
    if (listInFlight.current) return
    listInFlight.current = true
    try {
      const result = await listServicesAction()
      setError(result.error ?? null)
      // A failed read keeps the last known sessions; it must not look like every connection closed.
      if (result.error) return
      setClients(result.mcpClients)
      setLogRef(streamMcpLogRef(result.services))
    } finally {
      listInFlight.current = false
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => void refreshList(), LIST_POLL_MS)
    return () => window.clearInterval(id)
  }, [refreshList])

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [])

  // The connection closed: leave the live output and say why.
  useEffect(() => {
    if (!open || error) return
    if (openSessionAfterRefresh(clients, open.id)) return
    setEndedName(open.name)
    setOpen(null)
  }, [clients, error, open])

  const loadOutput = useCallback(async (sessionId: string, ref: string | null) => {
    if (!ref) {
      setOutputError('The stream MCP container is not running, so live output cannot be read.')
      return
    }
    const result = await serviceLogsAction(ref, OUTPUT_TAIL_LINES)
    if (result.error) {
      setOutputError(result.error)
      return
    }
    setOutputError(null)
    setOutput(filterMcpSessionLogs(result.logs, sessionId))
  }, [])

  useEffect(() => {
    if (!open) return
    void loadOutput(open.id, logRef)
    const id = window.setInterval(() => void loadOutput(open.id, logRef), OUTPUT_POLL_MS)
    return () => window.clearInterval(id)
  }, [open, logRef, loadOutput])

  const openSession = (client: McpClientStatus) => {
    setEndedName(null)
    setOutput('')
    setOutputError(null)
    setOpen({ id: client.id, name: client.clientName })
  }

  if (open) {
    const current = clients.find((client) => client.id === open.id)
    return (
      <section className="panel overview-panel mcp-live-panel" aria-label="Live MCP activity">
        <div className="overview-panel-head mcp-live-detail-head">
          <button type="button" className="btn sm ghost" onClick={() => setOpen(null)}>
            <Icon name="arrow_back" size={14} /> All sessions
          </button>
          <span className="state-badge accent inline-icon-label"><i className="live-dot" aria-hidden="true" />live</span>
        </div>
        <div className="mcp-live-detail-title">
          <span className="cell-strong">{open.name}</span>
          <span className="cell-mono service-image">{open.id}</span>
          {current ? (
            <span className="note">
              Last seen {formatSeenAgo(current.lastSeenAt, nowMs)} · closes when idle in {formatMcpTerminateCountdown(current.terminatesAt, nowMs)}
            </span>
          ) : null}
        </div>
        {outputError ? (
          <div className="notice with-icon danger mcp-live-notice" role="alert">
            <span className="n-ic"><Icon name="error_outline" size={16} /></span>
            <span className="n-body">{outputError}</span>
          </div>
        ) : null}
        <LogOutput
          text={output}
          fallback="No session communication yet."
          variant="terminal"
          showTimeToggle
          className="mcp-live-output"
          ariaLabel={`Live output for ${open.name}`}
        />
      </section>
    )
  }

  return (
    <section className="panel overview-panel mcp-live-panel" aria-label="Live MCP activity">
      <div className="overview-panel-head">
        <div>
          <h2 className="card-title">Live MCP activity</h2>
          <p className="card-sub">Stream connections to the MCP service right now. Select one to watch its live output.</p>
        </div>
        {!error && clients.length > 0 ? (
          <span className="state-badge accent inline-icon-label">
            <i className="live-dot" aria-hidden="true" />{clients.length} streaming
          </span>
        ) : null}
      </div>
      {endedName ? (
        <div className="notice with-icon mcp-live-notice" role="status">
          <span className="n-ic"><Icon name="link_off" size={16} /></span>
          <span className="n-body"><b>{endedName}</b> disconnected, so its live output closed.</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setEndedName(null)}>
            <Icon name="close" size={15} />
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="overview-panel-empty">
          <Icon name="sensors_off" size={22} />
          <span>Live sessions are unavailable: {error}</span>
        </div>
      ) : clients.length === 0 ? (
        <div className="overview-panel-empty">
          <Icon name="sensors" size={22} />
          <span>No active MCP streams. Sessions appear here while Claude or Codex is connected and leave when they disconnect.</span>
        </div>
      ) : (
        <div className="gt mcp-live-table">
          <div className="gt-head" style={{ gridTemplateColumns: MCP_LIVE_COLS }}>
            <div>Client</div>
            <div>Connection</div>
            <div>Last seen</div>
            <div>Terminates at</div>
            <div aria-hidden="true" />
          </div>
          <div className="gt-scroll-body">
            {clients.map((client) => {
              const closesAt = formatMcpTerminateTime(client.terminatesAt)
              return (
                <button
                  type="button"
                  key={client.id}
                  className="gt-row mcp-live-row"
                  style={{ gridTemplateColumns: MCP_LIVE_COLS }}
                  aria-label={`Open live output for ${client.clientName}`}
                  onClick={() => openSession(client)}
                >
                  <span className="service-cell">
                    <i className={`dot ${client.connectionType === 'stream' ? 'ok live' : 'warn'}`} aria-hidden="true" />
                    <span className="service-cell-text">
                      <span className="cell-strong">{client.clientName}</span>
                      <span className="cell-mono service-image">{client.id}</span>
                    </span>
                  </span>
                  <span className="cell-mono mcp-connection-cell">
                    {client.connectionType === 'stream' ? 'streamable-http' : 'legacy local stdio'}
                  </span>
                  <span className="mcp-time-cell cell-mono">{formatSeenAgo(client.lastSeenAt, nowMs)}</span>
                  <span className="mcp-time-cell">
                    <span className="cell-mono">{formatMcpTerminateCountdown(client.terminatesAt, nowMs)}</span>
                    {closesAt ? <span className="note">{closesAt}</span> : null}
                  </span>
                  <span className="mcp-live-chevron" aria-hidden="true"><Icon name="chevron_right" size={16} /></span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
