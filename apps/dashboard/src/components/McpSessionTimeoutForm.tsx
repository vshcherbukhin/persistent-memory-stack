'use client'

import { useActionState, useEffect, useState } from 'react'
import { saveMcpSessionTimeoutAction, type SettingsState } from '@/app/(dashboard)/settings/actions'
import type { Settings } from '@/lib/types'

const initial: SettingsState = {}

export function McpSessionTimeoutForm({ current, showHeader = true }: { current: Settings; showHeader?: boolean }) {
  const [state, formAction, pending] = useActionState(saveMcpSessionTimeoutAction, initial)
  const currentMinutes = String(Math.max(1, Math.round(current.mcpSessionIdleTimeoutSeconds / 60)))
  const [minutes, setMinutes] = useState(currentMinutes)
  const [base, setBase] = useState(currentMinutes)
  const dirty = minutes !== base

  useEffect(() => {
    if (state.ok) setBase(minutes)
  }, [state, minutes])

  return (
    <form action={formAction}>
      {showHeader ? (
        <>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Stream service session timeout</h2>
          <p className="muted" style={{ marginBottom: 14, maxWidth: 680 }}>
            Inactive Stream MCP sessions are closed after this idle period. Codex and Claude can open a fresh session automatically.
          </p>
        </>
      ) : null}
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="mcp-session-timeout">Session timeout (minutes)</label>
        <input
          id="mcp-session-timeout"
          name="mcpSessionIdleTimeoutMinutes"
          type="number"
          min="1"
          max="1440"
          step="1"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Default is 15 minutes. Saving restarts the Stream MCP service so the new timeout is applied.
        </div>
      </div>
      {state.error ? <div className="notice danger" style={{ marginTop: 8 }}>{state.error}</div> : null}
      {state.warning ? <div className="notice warn" style={{ marginTop: 8 }}>{state.warning}</div> : null}
      {state.ok ? <div className="notice ok" style={{ marginTop: 8 }}>Saved.</div> : null}
      <button type="submit" className="btn primary" disabled={pending || !dirty} style={{ marginTop: 10 }}>
        {pending ? 'Saving...' : 'Save timeout'}
      </button>
    </form>
  )
}
