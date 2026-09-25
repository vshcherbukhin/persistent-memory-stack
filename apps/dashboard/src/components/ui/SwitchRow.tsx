'use client'

import { StatusToggle } from './StatusToggle'

/** Prototype switch row: the label on the left, the switch on the right, a hairline between rows. */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
  emphasis = false,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  emphasis?: boolean
}) {
  return (
    <div className={`switch-row${emphasis ? ' emphasis' : ''}${disabled ? ' disabled' : ''}`}>
      <span className="switch-row-label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </span>
      <StatusToggle checked={checked} ariaLabel={label} disabled={disabled} onClick={() => onChange(!checked)} />
    </div>
  )
}
