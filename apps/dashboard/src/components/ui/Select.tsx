'use client'

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

export interface SelectOption {
  value: string
  label: string
}

/**
 * Custom accessible Select (P2). Replaces native <select> because the native option
 * popup can't be themed (the "ugly system option list" complaint). Renders a styled
 * trigger + listbox with keyboard nav (↑/↓/Enter/Esc), click-outside close, and ARIA
 * listbox semantics. Emits a hidden <input name=…> so it still submits inside the
 * existing FormData server-action forms.
 *
 * ponytail: no type-ahead / scroll-into-view — the option lists here are short (teams,
 * severities, categories); add them only if a long list appears.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  ariaLabel,
  name,
}: {
  value: string | null
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  name?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [listStyle, setListStyle] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const selected = options.find((o) => o.value === value) ?? null

  const updateListStyle = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const menuHeight = Math.min(260, listRef.current?.scrollHeight ?? 260)
    const spaceBelow = window.innerHeight - rect.bottom - 5
    const spaceAbove = rect.top - 5
    const openUpward = spaceBelow < menuHeight && spaceAbove > spaceBelow
    const maxHeight = Math.max(0, Math.min(menuHeight, openUpward ? spaceAbove : spaceBelow))
    setListStyle({
      top: openUpward ? rect.top - maxHeight - 5 : rect.bottom + 5,
      left: rect.left,
      width: rect.width,
      maxHeight,
    })
  }, [])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // On open, highlight the currently-selected option.
  useEffect(() => {
    if (!open) return
    const i = options.findIndex((o) => o.value === value)
    setActive(i >= 0 ? i : 0)
    updateListStyle()
  }, [open, value, options, updateListStyle])

  useEffect(() => {
    if (!open) return
    updateListStyle()
    window.addEventListener('resize', updateListStyle)
    window.addEventListener('scroll', updateListStyle, true)
    return () => {
      window.removeEventListener('resize', updateListStyle)
      window.removeEventListener('scroll', updateListStyle, true)
    }
  }, [open, updateListStyle])

  function commit(i: number) {
    const opt = options[i]
    if (opt) {
      onChange(opt.value)
      setOpen(false)
    }
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (disabled) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!open) setOpen(true)
        else setActive((a) => Math.min(a + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        if (open) setActive((a) => Math.max(a - 1, 0))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (open) commit(active)
        else setOpen(true)
        break
      case 'Escape':
        if (open) {
          e.preventDefault()
          setOpen(false)
        }
        break
    }
  }

  const listbox = open ? (
    <ul
      ref={listRef}
      className="ui-select-list ui-select-portal"
      role="listbox"
      aria-label={ariaLabel}
      style={{
        top: listStyle?.top ?? 0,
        left: listStyle?.left ?? 0,
        width: listStyle?.width ?? undefined,
        maxHeight: listStyle?.maxHeight ?? undefined,
        visibility: listStyle ? 'visible' : 'hidden',
      }}
    >
      {options.map((o, i) => (
        <li
          key={o.value}
          role="option"
          aria-selected={o.value === value}
          className={
            'ui-select-opt' + (i === active ? ' active' : '') + (o.value === value ? ' selected' : '')
          }
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault() // keep focus on the trigger; avoid blur-close race
            commit(i)
          }}
        >
          <span>{o.label}</span>
          {o.value === value ? (
            <span className="ui-select-check" aria-hidden>
              <Icon name="check" size={15} />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  ) : null

  return (
    <div className={disabled ? 'ui-select disabled' : 'ui-select'} ref={ref}>
      {name ? <input type="hidden" name={name} value={value ?? ''} /> : null}
      <button
        ref={triggerRef}
        type="button"
        className="ui-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? undefined : 'ui-select-ph'}>{selected ? selected.label : placeholder}</span>
        <span className="ui-select-caret" aria-hidden>
          <Icon name="keyboard_arrow_down" size={18} />
        </span>
      </button>
      {listbox && typeof document !== 'undefined' ? createPortal(listbox, document.body) : null}
    </div>
  )
}
