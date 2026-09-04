'use client'

import { useActionState, useEffect, useState } from 'react'
import { issueTokenAction, type IssueState } from '@/app/(dashboard)/tokens/actions'
import { DateTimePicker } from '@/components/ui/DateTimePicker'
import { Icon } from '@/components/ui/Icon'
import { Modal } from '@/components/ui/Modal'
import { Tooltip } from '@/components/ui/Tooltip'

const initial: IssueState = {}

/**
 * Per-user token issue/rotate control + the SHOW-ONCE modal.
 *
 * The wire token comes back from the server action exactly once (the API never
 * stores or re-returns it). We render it in a copy-to-clipboard modal with a
 * "you will not see this again" warning, and drop it from state the moment the
 * modal closes — it is never persisted client-side or refetched.
 */
export function TokenModal({
  userId,
  userLabel,
  hasToken,
}: {
  userId: string
  userLabel: string
  hasToken: boolean
}) {
  const [state, formAction, pending] = useActionState(issueTokenAction, initial)
  const [shownNonce, setShownNonce] = useState<number | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)

  // Open the modal whenever a NEW wireToken arrives (nonce changes).
  const open = !!state.wireToken && state.nonce !== undefined && state.nonce !== shownNonce
  const closed = state.nonce === shownNonce

  useEffect(() => {
    setCopied(false)
  }, [state.nonce])

  function dismiss() {
    setShownNonce(state.nonce) // discard the token from the visible flow
  }

  return (
    <>
      <form action={formAction} className="row" style={{ gap: 6 }}>
        <input type="hidden" name="id" value={userId} />
        <input type="hidden" name="rotate" value={hasToken ? 'true' : 'false'} />
        <div style={{ width: 210 }}>
          <DateTimePicker name="expiresAt" value={expiresAt} onChange={setExpiresAt} ariaLabel="Optional token expiry" />
        </div>
        <button type="submit" disabled={pending} className={hasToken ? 'secondary' : ''}>
          {pending ? 'Minting…' : hasToken ? 'Rotate' : 'Issue'}
        </button>
      </form>
      {state.error && closed ? (
        <div className="notice danger" style={{ marginTop: 6 }}>
          {state.error}
        </div>
      ) : null}

      {open ? (
        <Modal
          title={`Token for ${userLabel}`}
          onClose={dismiss}
          accent
          footer={<button type="button" onClick={dismiss}>Done</button>}
        >
          <div
            style={{
              color: 'var(--accent)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            New token · shown once
          </div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Copy it now — only the argon2id hash is stored, so it won&apos;t be shown again. Put
            it in the MCP client config as <span className="mono">PM_USER_TOKEN</span>.
          </p>
          <div className="token-box" id="wire-token" style={{ marginTop: 8 }}>
            <code>{state.wireToken}</code>
            <Tooltip label={copied ? 'Copied' : 'Copy token'}>
              <button
                type="button"
                className="copy"
                aria-label="Copy token"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(state.wireToken!)
                    setCopied(true)
                  } catch {
                    setCopied(false)
                  }
                }}
              >
                <Icon name={copied ? 'check' : 'content_copy'} size={15} />
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </Tooltip>
          </div>
          <p className="note" style={{ margin: '4px 0 0' }}>
            tokenId <span className="mono">{state.tokenId}</span>
            {state.expiresAt
              ? ` · expires ${new Date(state.expiresAt).toLocaleString()}`
              : ' · non-expiring'}
          </p>
        </Modal>
      ) : null}
    </>
  )
}
