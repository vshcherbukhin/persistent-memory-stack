'use client'

import { useActionState, useEffect, useState } from 'react'
import { saveMcpSessionTimeoutAction, type SettingsState } from '@/app/(dashboard)/settings/actions'
import { Input } from '@/components/ui/Input'
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
      {/* Prototype d-settings: a compact mono number field with its consequence stated underneath. */}
      <div className="settings-form-stack">
        <div className="field">
          <label className="field-label" htmlFor="mcp-session-timeout">Session timeout (minutes)</label>
          <Input
            id="mcp-session-timeout"
            name="mcpSessionIdleTimeoutMinutes"
            type="number"
            min="1"
            max="1440"
            step="1"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            className="mono settings-number-input"
          />
          <span className="field-hint">
            Default is 15 minutes. Saving restarts the Stream MCP service so the new timeout is applied.
          </span>
        </div>
        {state.error ? <div className="notice danger">{state.error}</div> : null}
        {state.warning ? <div className="notice warn">{state.warning}</div> : null}
        {state.ok ? <div className="notice ok">Saved.</div> : null}
        <div className="btn-row">
          <button type="submit" className="btn primary" disabled={pending || !dirty}>
            {pending ? 'Saving…' : 'Save timeout'}
          </button>
        </div>
      </div>
    </form>
  )
}
