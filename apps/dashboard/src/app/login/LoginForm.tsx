'use client'

import { useActionState, useState } from 'react'
import { loginAction, type LoginState } from './actions'
import { ProductMark } from '@/components/ui/ProductMark'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { MemoryLattice } from '@/components/ui/MemoryLattice'
import type { DashboardLoginMode } from '@/lib/types'

const initial: LoginState = {}

/**
 * Login form (prototype a-login / a-login-error). Local mode keeps the optional
 * dashboard soft lock. Server mode uses email/password for humans, with token
 * recovery as the break-glass fallback. SSO mode shows the SSO notice plus the
 * same recovery-token fallback.
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
  const failed = Boolean(state.error)

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-crest">
          <span className="brand-mark login-brand-mark" aria-hidden="true">
            <ProductMark />
          </span>
          <div className="login-crest-name">Persistent Memory</div>
          <div className="eyebrow login-crest-sub">{local ? 'Local dashboard' : 'Shared server console'}</div>
          <MemoryLattice width={300} height={92} opacity={0.8} className="login-crest-lattice" />
        </div>

        <div className="login-body">
          <h1>{local ? 'Unlock dashboard' : recovery ? 'Use recovery token' : sso ? 'Sign in with SSO' : 'Sign in'}</h1>
          <p className="login-lead">
            {local ? (
              'This dashboard is protected by a password. Enter it to continue.'
            ) : recovery ? (
              'Paste the recovery token issued for this server. It is the break-glass path when the password or SSO is unavailable.'
            ) : sso ? (
              'Use your work identity when SSO is enabled. If SSO is unavailable, use your recovery token.'
            ) : (
              'Enter your dashboard email and password. MCP and API tokens are reserved for automation and recovery.'
            )}
          </p>

          {failed ? (
            <div className="notice with-icon fault" role="alert">
              <span className="n-ic"><Icon name="error_outline" size={16} /></span>
              <span className="n-body">
                <span className="notice-title">{local ? 'Could not unlock' : 'Could not sign in'}</span>
                {state.error}
              </span>
            </div>
          ) : null}

          <form action={formAction} className="login-form">
            {local ? (
              <>
                <input type="hidden" name="authMode" value="local-password" />
                <div className="field">
                  <label className="field-label" htmlFor="password">Password</label>
                  <Input id="password" name="password" type="password" autoComplete="current-password" required className={failed ? 'invalid' : undefined} />
                </div>
              </>
            ) : recovery ? (
              <>
                <input type="hidden" name="authMode" value="recovery-token" />
                <div className="field">
                  <label className="field-label" htmlFor="token">Recovery token</label>
                  <Input id="token" name="token" placeholder="tokenId.secret" autoComplete="off" spellCheck={false} required className={`mono${failed ? ' invalid' : ''}`} />
                  <span className="field-hint">A PM token for a super-admin on this server.</span>
                </div>
              </>
            ) : sso ? (
              <>
                <input type="hidden" name="authMode" value="sso" />
                <div className="notice with-icon warn">
                  <span className="n-ic"><Icon name="warning" size={16} /></span>
                  <span className="n-body">
                    SSO provider wiring is enabled for this server. Use the recovery token option if the identity provider is unavailable.
                  </span>
                </div>
              </>
            ) : (
              <>
                <input type="hidden" name="authMode" value="password" />
                <div className="field">
                  <label className="field-label" htmlFor="email">Email</label>
                  <Input id="email" name="email" type="email" autoComplete="username" required className={failed ? 'invalid' : undefined} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="password">Password</label>
                  <Input id="password" name="password" type="password" autoComplete="current-password" required className={failed ? 'invalid' : undefined} />
                </div>
              </>
            )}
            {!sso || recovery || local ? (
              <button type="submit" className="btn primary block lg" disabled={pending}>
                <Icon name={local ? 'lock_open' : recovery ? 'key' : 'login'} size={16} />
                {pending
                  ? local
                    ? 'Unlocking…'
                    : recovery
                      ? 'Checking token…'
                      : 'Signing in…'
                  : local
                    ? 'Unlock'
                    : recovery
                      ? 'Use recovery token'
                      : 'Sign in'}
              </button>
            ) : null}
          </form>

          {!local ? (
            <>
              <div className="login-divider" aria-hidden="true">or</div>
              <button type="button" className="btn secondary block" onClick={() => setRecovery((v) => !v)}>
                {recovery ? (sso ? 'Back to SSO' : 'Back to password login') : 'Use recovery token'}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
