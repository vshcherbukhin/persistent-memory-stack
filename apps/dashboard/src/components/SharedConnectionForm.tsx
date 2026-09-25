'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import {
  disconnectSharedConnectionAction,
  saveSharedConnectionAction,
  testSharedConnectionAction,
  type SharedConnectionState,
} from '@/app/(dashboard)/connection/actions'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { MemoryLattice } from '@/components/ui/MemoryLattice'
import type { SharedConnectionStatus, SharedConnectionTestResult, WhoAmI } from '@/lib/types'

const initial: SharedConnectionState = {}
type SharedConnectionTestError = { ok: false; message: string }

function identityLabel(result: SharedConnectionStatus['remoteIdentity'] | SharedConnectionTestResult['whoami'] | null): string {
  if (!result) return 'Not connected'
  const name = result.userEmail || result.userDisplayName || result.userId.slice(0, 8)
  return result.teamName ? `${name} / ${result.teamName}` : name
}

function roleLabel(identity: WhoAmI): string {
  if (identity.isGlobalSuperuser || identity.adminLevel === 'superuser') return 'super-admin'
  if (identity.isTeamAdmin || identity.adminLevel === 'admin') return 'team-admin'
  return 'member'
}

function hostOf(url: string | null): string {
  if (!url) return '—'
  try {
    return new URL(url).host
  } catch {
    return url
  }
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

/**
 * Shared Memories Server connection (prototype s-connect-new / s-connect-ok / s-connect-rejected).
 * Not connected: the whole Shared space collapses to this one form. Connected: the server,
 * the identity the token grants, and the embedding contract, with the token replaceable in place.
 */
export function SharedConnectionForm({ current }: { current: SharedConnectionStatus }) {
  const [saveState, saveAction, saving] = useActionState(saveSharedConnectionAction, initial)
  const [disconnectState, disconnectAction, disconnecting] = useActionState(disconnectSharedConnectionAction, initial)
  const [apiUrl, setApiUrl] = useState(current.apiUrl ?? '')
  const [token, setToken] = useState('')
  const [test, setTest] = useState<SharedConnectionTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [connectedSeconds, setConnectedSeconds] = useState(0)
  const [replacing, setReplacing] = useState(false)
  const [isPending, startTransition] = useTransition()
  const busy = saving || disconnecting || isPending
  const testedOk = test?.compatibility.ok === true && !testError
  const connectLabel = current.configured || disconnectState.ok ? 'Reconnect now' : 'Connect'
  const connected = current.configured && !disconnectState.ok
  const compatibility = current.compatibility

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

  const form = (
    <form action={saveAction} className="connection-form">
      <div className="field">
        <label className="field-label" htmlFor="sharedApiUrl">Shared Memories Server API URL</label>
        <Input id="sharedApiUrl" name="sharedApiUrl" type="url" value={apiUrl} onChange={(e) => updateApiUrl(e.target.value)} placeholder="https://memory.example.test" required className="mono" />
        <span className="field-hint">The Persistent Memory API URL printed by the shared server installer.</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="sharedToken">Connector token</label>
        <Input
          id="sharedToken"
          name="sharedToken"
          type="password"
          value={token}
          onChange={(e) => updateToken(e.target.value)}
          placeholder={current.tokenConfigured ? 'configured - paste a new token to rotate' : 'tokenId.secret'}
          autoComplete="off"
          required
          className={`mono${testError && !test ? ' invalid' : ''}`}
        />
        <span className="field-hint">Issued to you by a super-admin on that server. Stored here as a masked secret.</span>
      </div>

      {test && test.compatibility.ok && !testError ? (
        <div className="notice with-icon ok">
          <span className="n-ic"><Icon name="check" size={16} /></span>
          <span className="n-body">
            Server reachable — connected as {identityLabel(test.whoami)}. Shared server uses {test.config.embeddingTopology}; pin{' '}
            <code>{test.config.activeModel} @ {test.config.activeDim}</code>.
          </span>
        </div>
      ) : null}
      {testError ? (
        test ? (
          // Reachable and accepted, but the embedding contract does not line up: a separate problem.
          <div className="notice with-icon warn">
            <span className="n-ic"><Icon name="warning" size={16} /></span>
            <span className="n-body">
              <span className="notice-title">Embedding pin mismatch</span>
              {testError}
            </span>
          </div>
        ) : (
          <div className="notice with-icon fault">
            <span className="n-ic"><Icon name="lock" size={16} /></span>
            <span className="n-body">
              <span className="notice-title">Connection test failed</span>
              {testError}
            </span>
          </div>
        )
      ) : null}
      {saveState.error ? <div className="notice danger">{saveState.error}</div> : null}
      {disconnectState.error ? <div className="notice danger">{disconnectState.error}</div> : null}
      {saveState.warning ? <div className="notice warn">{saveState.warning}</div> : null}
      {disconnectState.warning ? <div className="notice warn">{disconnectState.warning}</div> : null}
      {saveState.ok ? <div className="notice ok">Shared Memories connection saved.</div> : null}
      {disconnectState.ok ? <div className="notice ok">Shared Memories disconnected. Paste a connector token and choose Reconnect now when you are ready.</div> : null}

      <div className="btn-row">
        <button type="button" className="btn secondary" onClick={runTest} disabled={busy || !apiUrl || !token}>
          <Icon name="cloud_sync" size={15} /> {isPending ? 'Testing…' : 'Test connection'}
        </button>
        <button type="submit" className="btn primary" disabled={busy || !apiUrl || !token || !testedOk}>{connectLabel}</button>
        {replacing ? (
          <button type="button" className="btn ghost" onClick={() => setReplacing(false)}>Cancel</button>
        ) : (
          <span className="note">Nothing is saved until the test succeeds.</span>
        )}
      </div>
    </form>
  )

  if (!connected) {
    return (
      <div className="connection-new">
        <div className="connection-hero">
          <MemoryLattice width={280} height={130} className="connection-hero-art" />
          <h2>Connect Shared Memories</h2>
          <p className="lede">
            A Shared Memories server lets a team read and write a common corpus. Your Personal Memories stay local and
            separate — connecting does not merge them.
          </p>
        </div>
        <section className="panel connection-card" aria-label="Shared Memories Server connection">
          {form}
        </section>
        <div className="notice with-icon">
          <span className="n-ic"><Icon name="info" size={16} /></span>
          <span className="n-body">
            Your permissions on the shared server are exactly what the token grants — this dashboard cannot widen them.
            Team administration happens on the server console.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="connection-grid">
      <section className="panel connection-card" aria-label="Shared Memories Server connection">
        <div className="card-head">
          <div>
            <h2 className="card-title">Shared Memories server</h2>
            <div className="card-sub mono">{hostOf(current.apiUrl)}</div>
          </div>
          <span className="badge ok up inline-icon-label"><i className="dot ok live" aria-hidden="true" /> connected</span>
        </div>
        <div className="kv">
          <div className="kv-row"><span>Connected as</span><span>{identityLabel(current.remoteIdentity)}</span></div>
          {current.remoteIdentity?.teamName ? (
            <div className="kv-row"><span>Team</span><span>{current.remoteIdentity.teamName}</span></div>
          ) : null}
          {current.remoteIdentity ? (
            <div className="kv-row"><span>Role granted by token</span><span><span className="badge up">{roleLabel(current.remoteIdentity)}</span></span></div>
          ) : null}
          <div className="kv-row"><span>Connector token</span><span>{current.tokenConfigured ? 'masked token saved' : 'not saved'}</span></div>
          <div className="kv-row"><span>Connected time</span><span className="mono">{formatDuration(connectedSeconds)}</span></div>
          <div className="kv-row"><span>Server</span><code>{current.apiUrl}</code></div>
        </div>
        <div className="btn-row connection-actions">
          <button type="button" className="btn secondary" disabled={busy || replacing} onClick={() => setReplacing(true)}>
            <Icon name="key" size={15} /> Replace token
          </button>
          <form action={disconnectAction}>
            <button type="submit" className="btn danger" disabled={busy}>Disconnect</button>
          </form>
        </div>
        {replacing ? <div className="connection-replace">{form}</div> : null}
      </section>

      <div className="connection-side">
        <section className="panel connection-card" aria-label="Embedding contract">
          <div className="card-head">
            <h2 className="card-title">Embedding contract</h2>
            {compatibility ? (
              <span className={`badge up ${compatibility.ok ? 'ok' : 'warn'}`}>{compatibility.ok ? 'compatible' : 'mismatch'}</span>
            ) : null}
          </div>
          {current.remoteConfig ? (
            <div className="kv">
              <div className="kv-row"><span>Server pin</span><code>{current.remoteConfig.activeModel} @ {current.remoteConfig.activeDim}</code></div>
              <div className="kv-row"><span>Topology</span><span>{current.remoteConfig.embeddingTopology}</span></div>
            </div>
          ) : (
            <p className="note">The server configuration has not been read yet.</p>
          )}
          {compatibility ? (
            <div className={`notice with-icon ${compatibility.ok ? 'ok' : 'warn'}`}>
              <span className="n-ic"><Icon name={compatibility.ok ? 'check' : 'warning'} size={16} /></span>
              <span className="n-body">
                {compatibility.ok
                  ? compatibility.requiresLocalEmbedding
                    ? 'Compatible. The server uses client-managed embeddings, so your local model embeds shared queries.'
                    : 'Compatible, so shared search works without a local re-embed.'
                  : compatibility.reason ?? 'The server embedding pin does not match this dashboard.'}
              </span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}
