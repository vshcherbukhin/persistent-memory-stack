'use client'

import { useActionState, useEffect, useState } from 'react'
import { Modal } from './ui/Modal'
import { Avatar } from './ui/Avatar'
import { Checkbox } from './ui/Checkbox'
import { updateProfileAction, type ProfileActionState } from '@/app/(dashboard)/profile/actions'
import { assessPasswordStrength, generateStrongPassword } from '@/lib/passwordStrength'
import type { Profile } from '@/lib/types'

const INIT: ProfileActionState = {}

/**
 * Profile modal — opened from the bottom-left nav. Edit display name + email,
 * and change the dashboard password. In server mode users must prove the old
 * password; super-admin reset lives on the Users page.
 */
export function ProfileModal({
  profile,
  localMode,
  roleLabel,
  roleClass,
  onClose,
}: {
  profile: Profile
  localMode: boolean
  roleLabel: string
  roleClass: 'super' | 'admin' | 'member'
  onClose: () => void
}) {
  const [save, saveAction, saving] = useActionState(updateProfileAction, INIT)
  const [displayName, setDisplayName] = useState(profile.displayName ?? '')
  const [email, setEmail] = useState(profile.email ?? '')
  const [base, setBase] = useState({ displayName: profile.displayName ?? '', email: profile.email ?? '' })
  const [removePw, setRemovePw] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [generated, setGenerated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [recoveryCopied, setRecoveryCopied] = useState(false)
  const strength = pw ? assessPasswordStrength(pw) : null
  const pwMismatch = !removePw && pw.length > 0 && pw !== confirm
  const missingCurrentPassword = !removePw && pw.length > 0 && profile.hasPassword && currentPw.length === 0
  const weakPassword = !removePw && pw.length > 0 && strength ? !strength.accepted : false
  // Save is a dirty gate: enabled only when something actually changed (name/email/password).
  const dirty = displayName !== base.displayName || email !== base.email || pw.length > 0 || removePw
  const canSave = dirty && !pwMismatch && !weakPassword && !missingCurrentPassword && !saving

  useEffect(() => {
    if (save.ok) {
      setBase({ displayName, email }) // new baseline; secrets reset
      setCurrentPw('')
      setPw('')
      setConfirm('')
      setRemovePw(false)
      setGenerated(null)
      setRecoveryCopied(false)
    }
  }, [save]) // eslint-disable-line react-hooks/exhaustive-deps

  const createPassword = () => {
    const next = generateStrongPassword()
    setPw(next)
    setConfirm(next)
    setGenerated(next)
    setCopied(false)
    setRemovePw(false)
  }

  const copyGenerated = async () => {
    if (!generated) return
    await navigator.clipboard.writeText(generated)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const copyRecovery = async () => {
    if (!save.recoveryToken) return
    await navigator.clipboard.writeText(save.recoveryToken)
    setRecoveryCopied(true)
    window.setTimeout(() => setRecoveryCopied(false), 1400)
  }

  const name = displayName || profile.email || 'You'

  return (
    <Modal title="Your profile" onClose={onClose}>
      {/* Identity */}
      <div className="row" style={{ gap: 14, alignItems: 'center' }}>
        <Avatar name={name} email={profile.email ?? undefined} size={56} />
        <div>
          <div style={{ fontWeight: 800 }}>{name}</div>
          <div className="muted" style={{ fontSize: 12 }}>{profile.email ?? 'No email set'}</div>
        </div>
      </div>

      {/* Details + password */}
      <form action={saveAction} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label htmlFor="pm-name">Display name</label>
          <input id="pm-name" name="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="ui-input" placeholder="Your name" />
        </div>
        <div className="field">
          <label htmlFor="pm-email">Email</label>
          <input id="pm-email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="ui-input" placeholder="you@company.com" />
        </div>

        {!localMode ? (
          <div className="row" style={{ gap: 8 }}>
            {!localMode ? <span className={`role-badge ${roleClass}`}>{roleLabel}</span> : null}
            {!localMode && profile.teamName ? <span className="head-team">{profile.teamName}</span> : null}
          </div>
        ) : null}

        <div className="seg-group" style={{ borderTop: '1px solid var(--divider-section)', paddingTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <span className="section-label">Dashboard password</span>
            <button type="button" className="secondary" onClick={createPassword}>Generate password</button>
          </div>
          <p className="note" style={{ margin: '0 0 8px' }}>
            {profile.hasPassword
              ? 'Change your dashboard password by entering the current password and a strong new one.'
              : localMode
                ? 'No password is set. Set one to require dashboard login on this local stack.'
                : 'No password is set. Ask a super-admin for a reset if you cannot create one here.'}
          </p>
          {profile.passwordTemporary ? (
            <div className="notice warn" style={{ margin: 0 }}>
              Your current password is temporary. Change it before continuing normal work.
            </div>
          ) : null}
          {localMode && profile.hasPassword ? (
            <div style={{ marginBottom: 8 }}>
              <Checkbox name="removePassword" checked={removePw} onChange={setRemovePw} label="Remove the password (open the dashboard with no login)" />
            </div>
          ) : null}
          {!removePw ? (
            <>
              {profile.hasPassword ? (
                <div className="field">
                  <label htmlFor="pm-current-pw">Current password</label>
                  <input
                    id="pm-current-pw"
                    name="currentPassword"
                    type="password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    className="ui-input"
                    autoComplete="current-password"
                  />
                  {missingCurrentPassword ? <span className="field-hint" style={{ color: 'var(--coral)' }}>Enter the current password.</span> : null}
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="pm-pw">{profile.hasPassword ? 'New password' : 'Password'}</label>
                <input
                  id="pm-pw"
                  name="password"
                  type="password"
                  value={pw}
                  onChange={(e) => {
                    setPw(e.target.value)
                    setGenerated(null)
                  }}
                  className="ui-input"
                  placeholder="leave blank to keep"
                  autoComplete="new-password"
                />
                {strength ? (
                  <>
                    <div className={`password-meter ${strength.level}`} aria-hidden="true"><span /></div>
                    <span className="field-hint">{strength.accepted ? 'Strong password.' : strength.messages[0]}</span>
                  </>
                ) : null}
              </div>
              {pw.length > 0 ? (
                <div className="field">
                  <label htmlFor="pm-pwc">Confirm password</label>
                  <input id="pm-pwc" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="ui-input" autoComplete="new-password" />
                  {pwMismatch ? <span className="field-hint" style={{ color: 'var(--coral)' }}>Passwords do not match.</span> : null}
                </div>
              ) : null}
              {generated ? (
                <div className="notice warn" style={{ margin: 0 }}>
                  <div className="notice-title">Generated password shown once</div>
                  <div className="update-command-row">
                    <code>{generated}</code>
                    <button type="button" className="secondary" onClick={() => void copyGenerated()}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {save.error ? <div className="notice danger" style={{ margin: 0 }}>{save.error}</div> : null}
        {save.ok ? <div className="notice ok" style={{ margin: 0 }}>Saved.</div> : null}
        {save.recoveryToken ? (
          <div className="notice warn" style={{ margin: 0 }}>
            <div className="notice-title">Recovery token shown once</div>
            <p className="note" style={{ margin: '4px 0 10px' }}>
              Keep this token for MCP/API setup and emergency dashboard recovery.
            </p>
            <div className="update-command-row">
              <code>{save.recoveryToken}</code>
              <button type="button" className="secondary" onClick={() => void copyRecovery()}>
                {recoveryCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="submit" className="primary" disabled={!canSave}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  )
}
