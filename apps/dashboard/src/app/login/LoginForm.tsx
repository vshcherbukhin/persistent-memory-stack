'use client'

import { useActionState, useState } from 'react'
import { loginAction, type LoginState } from './actions'
import { ProductMark } from '@/components/ui/ProductMark'
import type { DashboardLoginMode } from '@/lib/types'

const initial: LoginState = {}

/**
 * Login form. Local mode keeps the optional dashboard soft lock. Server mode uses
 * email/password for humans, with token recovery as the break-glass fallback. SSO
 * mode shows the SSO card plus the same recovery-token fallback.
 */
export function LoginForm({
  mode,
  dashboardLoginMode = 'password',
}: {
  mode: 'local' | 'server'
  dashboardLoginMode?: DashboardLoginMode
}) {
  const [state, formAction, pending] = useActionState(loginAction, initial)
  const local = mode === 'local'
  const sso = !local && dashboardLoginMode === 'sso'
  const [recovery, setRecovery] = useState(false)

  return (
    <div className="login-wrap">
      <div className="login-stack">
        <div className="login-brand">
          <span className="brand-mark login-brand-mark" aria-hidden="true">
            <ProductMark />
          </span>
          <div>
            <div className="brand-name">PM Management</div>
            <div className="brand-sub">Persistent Memory Management</div>
          </div>
        </div>

        <div className="login-card">
          <h1>{local ? 'Unlock dashboard' : sso ? 'Sign in with SSO' : 'Sign in'}</h1>
          <p className="login-lead">
            {local ? (
              'Enter your dashboard password.'
            ) : sso ? (
              'Use your work identity when SSO is enabled. If SSO is unavailable, use your recovery token.'
            ) : (
              'Enter your dashboard email and password. MCP and API tokens are reserved for automation and recovery.'
            )}
          </p>
          <form action={formAction}>
            {local ? (
              <>
                <input type="hidden" name="authMode" value="local-password" />
                <div className="field">
                  <label htmlFor="password">Password</label>
                  <input id="password" name="password" type="password" autoComplete="current-password" required />
                </div>
              </>
            ) : recovery ? (
              <>
                <input type="hidden" name="authMode" value="recovery-token" />
                <div className="field">
                  <label htmlFor="token">Recovery token</label>
                  <input id="token" name="token" placeholder="tokenId.secret" autoComplete="off" spellCheck={false} required />
                </div>
              </>
            ) : sso ? (
              <>
                <input type="hidden" name="authMode" value="sso" />
                <div className="notice warn" style={{ marginTop: 0 }}>
                  SSO provider wiring is enabled for this server. Use the recovery token option if the identity provider is unavailable.
                </div>
              </>
            ) : (
              <>
                <input type="hidden" name="authMode" value="password" />
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input id="email" name="email" type="email" autoComplete="username" required />
                </div>
                <div className="field">
                  <label htmlFor="password">Password</label>
                  <input id="password" name="password" type="password" autoComplete="current-password" required />
                </div>
              </>
            )}
            {state.error ? <div className="notice danger">{state.error}</div> : null}
            {!sso || recovery || local ? (
              <button type="submit" className="primary" disabled={pending} style={{ width: '100%' }}>
                {pending
                  ? local
                    ? 'Unlocking...'
                    : recovery
                      ? 'Checking token...'
                      : 'Signing in...'
                  : local
                    ? 'Unlock'
                    : recovery
                      ? 'Use recovery token'
                      : 'Sign in'}
              </button>
            ) : null}
          </form>
          {!local ? (
            <button type="button" className="link" style={{ marginTop: 12 }} onClick={() => setRecovery((v) => !v)}>
              {recovery ? (sso ? 'Back to SSO' : 'Back to password login') : 'Use recovery token'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
