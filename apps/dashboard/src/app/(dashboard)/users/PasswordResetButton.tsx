'use client'

import { useActionState, useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { resetUserPasswordAction, type ResetPasswordState } from './actions'

const INIT: ResetPasswordState = {}

export function PasswordResetButton({ userId, userLabel }: { userId: string; userLabel: string }) {
  const [state, action, pending] = useActionState(resetUserPasswordAction, INIT)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (state.password) {
      setOpen(true)
      setCopied(false)
    }
  }, [state.password, state.nonce])

  const copy = async () => {
    if (!state.password) return
    await navigator.clipboard.writeText(state.password)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <>
      <form action={action} className="inline-form">
        <input type="hidden" name="id" value={userId} />
        <button
          type="submit"
          className="secondary"
          disabled={pending}
          onClick={(e) => {
            if (!window.confirm(`Reset ${userLabel}'s dashboard password? A temporary password will be shown once.`)) {
              e.preventDefault()
            }
          }}
        >
          {pending ? 'Resetting...' : 'Reset password'}
        </button>
      </form>
      {state.error ? <div className="notice danger" style={{ marginTop: 8 }}>{state.error}</div> : null}
      {open && state.password ? (
        <Modal title="Temporary password" onClose={() => setOpen(false)} width={520}>
          <div className="notice warn" style={{ marginTop: 0 }}>
            <div className="notice-title">Shown once</div>
            Share this temporary password with {userLabel}. They will be asked to change it after login.
          </div>
          <div className="update-command-row">
            <code>{state.password}</code>
            <button type="button" className="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
