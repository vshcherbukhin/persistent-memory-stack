'use client'

import type { ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * Themed checkbox (P5 follow-up). A visually-hidden native <input> (keeps a11y +
 * form submission — emits the value when `name` is set) behind a styled box, so it
 * matches the product design system instead of the browser default.
 */
export function Checkbox({
  checked,
  onChange,
  name,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  name?: string
  disabled?: boolean
  label?: ReactNode
}) {
  return (
    <label className="ui-check">
      <input type="checkbox" name={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ui-check-box" aria-hidden>
        <Icon name={checked ? 'check_box' : 'check_box_outline_blank'} size={21} />
      </span>
      {label != null ? <span className="ui-check-label">{label}</span> : null}
    </label>
  )
}
