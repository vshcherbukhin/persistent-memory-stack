'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import {
  disconnectSharedConnectionAction,
  saveSharedConnectionAction,
  testSharedConnectionAction,
  type SharedConnectionState,
} from '@/app/(dashboard)/connection/actions'
import { Input } from '@/components/ui/Input'
import type { SharedConnectionStatus, SharedConnectionTestResult } from '@/lib/types'

const initial: SharedConnectionState = {}
type SharedConnectionTestError = { ok: false; message: string }

function identityLabel(result: SharedConnectionStatus['remoteIdentity'] | SharedConnectionTestResult['whoami'] | null): string {
  if (!result) return 'Not connected'
  const name = result.userEmail || result.userDisplayName || result.userId.slice(0, 8)
  return result.teamName ? `${name} / ${result.teamName}` : name
}

function isTestError(result: SharedConnectionTestResult | SharedConnectionTestError): result is SharedConnectionTestError {
  return 'ok' in result && result.ok === false
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds)
  const days = Math.floor(safe / 86_400)
  const hours = Math.floor((safe % 86_400) / 3_600)
  const minutes = Math.floor((safe % 3_600) / 60)
  const secs = safe % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

export function SharedConnectionForm({ current }: { current: SharedConnectionStatus }) {
  const [saveState, saveAction, saving] = useActionState(saveSharedConnectionAction, initial)
  const [disconnectState, disconnectAction, disconnecting] = useActionState(disconnectSharedConnectionAction, initial)
  const [apiUrl, setApiUrl] = useState(current.apiUrl ?? '')
  const [token, setToken] = useState('')
  const [test, setTest] = useState<SharedConnectionTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [connectedSeconds, setConnectedSeconds] = useState(0)
  const [isPending, startTransition] = useTransition()
  const busy = saving || disconnecting || isPending
  const testedOk = test?.compatibility.ok === true && !testError
  const connectLabel = current.configured || disconnectState.ok ? 'Reconnect now' : 'Connect'

  useEffect(() => {
    if (!current.configured || !current.connectedAt) {
      setConnectedSeconds(0)
      return undefined
    }
    const connectedAt = new Date(current.connectedAt).getTime()
    const update = () => setConnectedSeconds(Math.floor((Date.now() - connectedAt) / 1000))
    update()
    const id = window.setInterval(update, 1000)
    return () => window.clearInterval(id)
  }, [current.configured, current.connectedAt])

  const updateApiUrl = (value: string) => {
    setApiUrl(value)
    setTest(null)
    setTestError(null)
  }

  const updateToken = (value: string) => {
    setToken(value)
    setTest(null)
    setTestError(null)
  }

  const runTest = () => {
    setTest(null)
    setTestError(null)
    startTransition(async () => {
      const result = await testSharedConnectionAction({ apiUrl, token })
      if (isTestError(result)) {
        setTestError(result.message)
      } else {
        setTest(result)
        if (!result.compatibility.ok) setTestError(result.compatibility.reason ?? 'Embedding topology mismatch.')
      }
    })
  }

  return (
    <div>
      <h2 className="card-title" style={{ marginBottom: 4 }}>Shared Memories Server connection</h2>
      <p className="muted" style={{ marginBottom: 14, maxWidth: 700 }}>
        Connect this local dashboard to one Shared Memories server with a server-issued connector token.
      </p>

      <div className="connection-status-card">
        <div className="connection-status-head">
          <span className={`state-badge ${current.configured ? 'ok' : 'warn'}`}>{current.configured ? 'Connected' : 'Not connected'}</span>
          {current.tokenConfigured ? <span className="badge-readonly">masked token saved</span> : null}
        </div>
        {current.configured ? (
          <div className="connection-stats">
            <div>
              <span>Connected as</span>
              <strong>{identityLabel(current.remoteIdentity)}</strong>
            </div>
            <div>
              <span>Connected time</span>
              <strong>{formatDuration(connectedSeconds)}</strong>
            </div>
            <div>
              <span>Server</span>
              <strong>{current.apiUrl}</strong>
            </div>
            {current.remoteConfig ? (
              <div>
                <span>Embeddings</span>
                <strong>{current.remoteConfig.embeddingTopology} · {current.remoteConfig.activeModel} @ {current.remoteConfig.activeDim}</strong>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Shared Memories are not connected yet. Personal Memories remain local.
          </p>
        )}
      </div>

      <form action={saveAction} className="settings-form">
        <div className="field">
          <label htmlFor="sharedApiUrl">Shared Memories Server API URL</label>
          <Input id="sharedApiUrl" name="sharedApiUrl" type="url" value={apiUrl} onChange={(e) => updateApiUrl(e.target.value)} placeholder="https://memory.example.test" required />
        </div>
        <div className="field">
          <label htmlFor="sharedToken">Connector token</label>
          <Input id="sharedToken" name="sharedToken" type="password" value={token} onChange={(e) => updateToken(e.target.value)} placeholder={current.tokenConfigured ? 'configured - paste a new token to rotate' : 'tokenId.secret'} autoComplete="off" required />
        </div>
        {test ? (
          <div className={`notice ${test.compatibility.ok ? 'ok' : 'warn'}`}>
            Connected as {identityLabel(test.whoami)}. Shared server uses {test.config.embeddingTopology}; pin {test.config.activeModel} @ {test.config.activeDim}.
          </div>
        ) : null}
        {testError ? <div className="notice danger">{testError}</div> : null}
        {saveState.error ? <div className="notice danger">{saveState.error}</div> : null}
        {disconnectState.error ? <div className="notice danger">{disconnectState.error}</div> : null}
        {saveState.warning ? <div className="notice warn">{saveState.warning}</div> : null}
        {disconnectState.warning ? <div className="notice warn">{disconnectState.warning}</div> : null}
        {saveState.ok ? <div className="notice ok">Shared Memories connection saved.</div> : null}
        {disconnectState.ok ? <div className="notice ok">Shared Memories disconnected. Paste a connector token and choose Reconnect now when you are ready.</div> : null}
        <div className="row" style={{ gap: 8 }}>
          <button type="button" onClick={runTest} disabled={busy || !apiUrl || !token}>Test connection</button>
          <button type="submit" className="primary" disabled={busy || !apiUrl || !token || !testedOk}>{connectLabel}</button>
        </div>
      </form>
      {current.configured && !disconnectState.ok ? (
        <form action={disconnectAction} style={{ marginTop: 12 }}>
          <button type="submit" className="danger" disabled={busy}>Disconnect</button>
        </form>
      ) : null}
    </div>
  )
}
