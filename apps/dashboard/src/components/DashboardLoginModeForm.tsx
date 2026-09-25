'use client'

import { useActionState, useState } from 'react'
import { saveDashboardLoginModeAction, type SettingsState } from '@/app/(dashboard)/settings/actions'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import type { DashboardLoginMode, Settings } from '@/lib/types'

const INIT: SettingsState = {}

export function DashboardLoginModeForm({ current, showHeader = true }: { current: Settings; showHeader?: boolean }) {
  const [state, action, pending] = useActionState(saveDashboardLoginModeAction, INIT)
  const [mode, setMode] = useState<DashboardLoginMode>(current.dashboardLoginMode)
  const dirty = mode !== current.dashboardLoginMode

  return (
    <form action={action}>
      {showHeader ? (
        <>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Dashboard login</h2>
          <p className="muted" style={{ marginBottom: 14, maxWidth: 680 }}>
            Password login is used for human dashboard sessions. SSO switches the login page to the SSO card; recovery tokens remain available for super-admin break-glass access.
          </p>
        </>
      ) : null}
      {/* Prototype d-settings: a two-way mode reads as a segmented control, not a dropdown. */}
      <div className="settings-form-stack">
        <div className="field">
          <span className="field-label">Login mode</span>
          <input type="hidden" name="dashboardLoginMode" value={mode} />
          <SegmentedControl
            ariaLabel="Dashboard login mode"
            className="settings-mode-switch"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'password', label: 'Password' },
              { value: 'sso', label: 'SSO' },
            ]}
          />
        </div>
        {mode === 'sso' ? (
          <div className="notice warn">
            Keep a valid super-admin recovery token before enabling SSO. The login page will offer token recovery if the identity provider is unavailable.
          </div>
        ) : null}
        <div className="btn-row">
          <button type="submit" className="btn primary" disabled={!dirty || pending}>
            {pending ? 'Saving…' : 'Save login mode'}
          </button>
          {state.error ? <span className="field-hint" style={{ color: 'var(--coral)' }}>{state.error}</span> : null}
          {state.ok ? <span className="field-hint" style={{ color: 'var(--grass)' }}>Saved.</span> : null}
        </div>
      </div>
    </form>
  )
}
