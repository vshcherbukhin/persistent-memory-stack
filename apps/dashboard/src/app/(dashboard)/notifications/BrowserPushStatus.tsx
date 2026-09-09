'use client'

import { useEffect, useState } from 'react'
import { Icon } from '@/components/ui/Icon'

type Permission = 'granted' | 'denied' | 'default' | 'unsupported'

const COPY: Record<Permission, { tone: 'ok' | 'warn' | 'danger'; label: string; detail: string }> = {
  granted: {
    tone: 'ok',
    label: 'Granted',
    detail: 'This browser will show notifications from the dashboard.',
  },
  denied: {
    tone: 'danger',
    label: 'Blocked',
    detail: 'This browser is blocking notifications for this site. Re-allow it in the address-bar site settings; the dashboard cannot prompt again once blocked.',
  },
  default: {
    tone: 'warn',
    label: 'Not requested',
    detail: 'Turn browser notifications on below and the browser will ask for permission.',
  },
  unsupported: {
    tone: 'warn',
    label: 'Unsupported',
    detail: 'This browser does not support the Notification API, so delivery here is unavailable.',
  },
}

/**
 * Delivery status for browser push. The settings below decide WHAT gets sent;
 * this says whether anything can arrive at all, which is where this usually
 * goes wrong — and lets the reader prove it with a real notification.
 */
export function BrowserPushStatus() {
  const [permission, setPermission] = useState<Permission | null>(null)
  const [worker, setWorker] = useState<boolean | null>(null)
  const [origin, setOrigin] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    setOrigin(window.location.host)
    if (typeof Notification === 'undefined') {
      setPermission('unsupported')
      setWorker(false)
      return
    }
    setPermission(Notification.permission as Permission)
    if (!('serviceWorker' in navigator)) {
      setWorker(false)
      return
    }
    void navigator.serviceWorker.getRegistrations().then(
      (registrations) => setWorker(registrations.length > 0),
      () => setWorker(false),
    )
  }, [])

  const sendTest = async () => {
    setBusy(true)
    setResult(null)
    try {
      const response = await fetch('/api/browser-push/test', { method: 'POST' })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setResult({ ok: false, message: body?.message ?? 'Test notification failed to send.' })
        return
      }
      // A queued send is not a delivered notification; say what actually happened.
      setResult({ ok: true, message: 'Test notification sent. If nothing appears, delivery is being blocked outside the dashboard.' })
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Test notification failed to send.' })
    } finally {
      setBusy(false)
    }
  }

  if (permission === null) return null
  const copy = COPY[permission]

  return (
    <section className="panel push-status" aria-label="Browser notification delivery">
      <div className="section-label">Delivery</div>
      <div className={`notice ${copy.tone} push-status-notice`}>
        <div className="notice-title">Browser permission: {copy.label}</div>
        {copy.detail}
      </div>
      <dl className="push-status-facts">
        <div>
          <dt>Origin</dt>
          <dd className="mono">{origin || '—'}</dd>
        </div>
        <div>
          <dt>Service worker</dt>
          <dd>{worker === null ? '—' : worker ? 'Registered' : 'Not registered'}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="btn secondary"
        disabled={busy || permission !== 'granted'}
        onClick={() => void sendTest()}
      >
        <Icon name="sensors" size={15} /> {busy ? 'Sending…' : 'Send a test notification'}
      </button>
      {result ? (
        <div className={`notice ${result.ok ? 'ok' : 'danger'} push-status-notice`} role="status">{result.message}</div>
      ) : null}
      {permission !== 'granted' ? (
        <p className="note" style={{ marginTop: 8 }}>
          A test can only be sent once this browser has granted permission.
        </p>
      ) : null}
    </section>
  )
}
