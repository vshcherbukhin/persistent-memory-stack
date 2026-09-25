'use client'

import { useEffect, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

/**
 * Reusable modal base (P2). Wraps the existing `.modal*` design-system classes
 * (backdrop blur, panel, head/body/foot) and adds Escape-to-close + backdrop-click
 * dismiss. Screens supply title / body / footer. `accent` uses the accent-bordered
 * variant (token-modal). Mirrors the hand-rolled pattern in TokenModal.tsx.
 */
export function Modal({
  title,
  icon,
  headActions,
  onClose,
  children,
  footer,
  width,
  accent,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  /** Leading glyph in the head that names the record type (prototype `.modal-head`). */
  icon?: ReactNode
  /** Record-level actions in the head, placed before the close button. */
  headActions?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  accent?: boolean
  className?: string
  bodyClassName?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className={`${accent ? 'modal token-modal' : 'modal'}${className ? ` ${className}` : ''}`}
        style={width ? { width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {title != null ? (
          <div className="modal-head">
            {icon ? <span className="modal-head-icon" aria-hidden="true">{icon}</span> : null}
            <h2>{title}</h2>
            {headActions ? <div className="modal-head-actions">{headActions}</div> : null}
            <Tooltip label="Close">
              <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
                <Icon name="close" size={17} />
              </button>
            </Tooltip>
          </div>
        ) : null}
        <div className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
        {footer != null ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}
