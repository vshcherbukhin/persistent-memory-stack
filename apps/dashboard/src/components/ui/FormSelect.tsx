'use client'

import { useState } from 'react'
import { Select, type SelectOption } from './Select'

/**
 * Self-contained client wrapper around <Select> for use inside SERVER-rendered
 * <form action={serverAction}> blocks: it holds its own state (seeded by defaultValue)
 * and emits the hidden <input name> that <Select> submits — so a native <select> can be
 * swapped for the themed dropdown without making the parent a client component.
 */
export function FormSelect({
  name,
  defaultValue,
  options,
  ariaLabel,
  disabled,
  onChange,
}: {
  name: string
  defaultValue?: string
  options: SelectOption[]
  ariaLabel?: string
  disabled?: boolean
  /** Optional notify-on-change (the custom Select doesn't bubble a native change event). */
  onChange?: (value: string) => void
}) {
  const [value, setValue] = useState(defaultValue ?? options[0]?.value ?? '')
  return (
    <Select
      name={name}
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
      options={options}
      ariaLabel={ariaLabel}
      disabled={disabled}
    />
  )
}
