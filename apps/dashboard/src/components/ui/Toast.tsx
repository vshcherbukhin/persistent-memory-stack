'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

type ToastKind = 'success' | 'warn' | 'error' | 'info'

interface ToastItemData {
  id: number
  kind: ToastKind
  message: string
}

export interface ToastApi {
  success(message: string): void
  info(message: string): void
  warn(message: string): void
  /** Errors PERSIST (no auto-dismiss) and gain copy + close controls. */
  error(message: string): void
}

const ToastCtx = createContext<ToastApi | null>(null)

/** Hook for screens to raise toasts. Throws if used outside <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

let seq = 0
const AUTO_DISMISS_MS = 4500

/**
 * Global toast provider (P2). Mounts a fixed top-right viewport above the UI.
 * success / info / warn auto-dismiss after ~4.5s; ERROR toasts persist until the user
 * dismisses them and expose a copy button (copies the full message for investigation).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItemData[]>([])

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++seq
      setToasts((t) => [...t, { id, kind, message }])
      if (kind !== 'error') {
        setTimeout(() => remove(id), AUTO_DISMISS_MS)
      }
    },
    [remove],
  )

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      info: (m) => push('info', m),
      warn: (m) => push('warn', m),
      error: (m) => push('error', m),
    }),
    [push],
  )

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-viewport" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

function ToastRow({ toast, onClose }: { toast: ToastItemData; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span className="toast-dot" aria-hidden />
      <div className="toast-msg">{toast.message}</div>
      {toast.kind === 'error' ? (
        <Tooltip label={copied ? 'Copied' : 'Copy error'}>
          <button
            type="button"
            className="toast-copy"
            aria-label="Copy error"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(toast.message)
                setCopied(true)
              } catch {
                setCopied(false)
              }
            }}
          >
            <Icon name={copied ? 'check' : 'content_copy'} size={15} />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label="Dismiss">
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </Tooltip>
    </div>
  )
}
