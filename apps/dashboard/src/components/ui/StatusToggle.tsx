'use client'

import { Icon } from './Icon'

export function StatusToggle({
  checked,
  disabled,
  ariaLabel,
  onClick,
  className,
}: {
  checked: boolean
  disabled?: boolean
  ariaLabel: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      className={`status-toggle-icon${checked ? ' on' : ''}${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
      aria-pressed={checked}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={checked ? 'toggle_on' : 'toggle_off'} size={36} />
    </button>
  )
}
