'use client'

import { useRef, type ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
}

/**
 * Prototype `.seg-row`: a small set of mutually exclusive choices on an inset track.
 * Behaves as a radio group — one tab stop, arrow keys move the selection.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  className,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}) {
  const track = useRef<HTMLDivElement>(null)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const move = (delta: number) => {
    if (options.length === 0) return
    const next = options[(Math.max(selectedIndex, 0) + delta + options.length) % options.length]
    onChange(next.value)
    window.requestAnimationFrame(() => track.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
  }
  return (
    <div
      ref={track}
      className={`seg-control${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (disabled) return
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        }
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (selectedIndex < 0 && index === 0) ? 0 : -1}
            className={`seg-option${selected ? ' active' : ''}`}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
