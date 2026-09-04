/**
 * Dumb presentational components — the deliberate restyle seams. Structure +
 * CSS-class hooks only; styled by styles.css to the product-owned dark theme. Mirrors the
 * dashboard app's look so the two apps stay consistent.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

export function ProgressBar({ value, indeterminate, tone }: { value?: number; indeterminate?: boolean; tone?: 'accent' | 'warn' | 'danger' }) {
  const toneClass = tone && tone !== 'accent' ? ` ${tone}` : ''
  return (
    <div className="bar">
      <div
        className={`bar-fill${toneClass}${indeterminate ? ' bar-indeterminate' : ''}`}
        style={indeterminate ? undefined : { width: `${Math.round((value ?? 0) * 100)}%` }}
      />
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export interface SelectOption {
  value: string
  label: string
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  ariaLabel,
}: {
  value: string | null
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [listStyle, setListStyle] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const selected = options.find((o) => o.value === value) ?? null

  const updateListStyle = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    setListStyle({
      top: rect.bottom + 5,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(260, Math.max(120, spaceBelow - 12)),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const selectedIndex = options.findIndex((o) => o.value === value)
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    updateListStyle()
  }, [open, options, updateListStyle, value])

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

  const commit = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (disabled) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) setOpen(true)
        else setActive((current) => Math.min(current + 1, options.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        if (!open) setOpen(true)
        else setActive((current) => Math.max(current - 1, 0))
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (open) commit(active)
        else setOpen(true)
        break
      case 'Escape':
        if (open) {
          event.preventDefault()
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
        maxHeight: listStyle?.maxHeight ?? 260,
        visibility: listStyle ? 'visible' : 'hidden',
      }}
    >
      {options.map((option, index) => (
        <li
          key={option.value}
          role="option"
          aria-selected={option.value === value}
          className={`ui-select-opt${index === active ? ' active' : ''}${option.value === value ? ' selected' : ''}`}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => {
            event.preventDefault()
            commit(index)
          }}
        >
          <span>{option.label}</span>
          {option.value === value ? <span className="ui-select-check" aria-hidden>✓</span> : null}
        </li>
      ))}
    </ul>
  ) : null

  return (
    <div className={disabled ? 'ui-select disabled' : 'ui-select'} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? undefined : 'ui-select-ph'}>{selected ? selected.label : placeholder}</span>
        <span className="ui-select-caret" aria-hidden>▾</span>
      </button>
      {listbox && typeof document !== 'undefined' ? createPortal(listbox, document.body) : null}
    </div>
  )
}

export type StepState = 'pending' | 'running' | 'done' | 'failed'

const STEP_GLYPH: Record<StepState, string> = { pending: '○', running: '◐', done: '✓', failed: '✗' }

export function StepList({ steps }: { steps: { id: string; name: string; state: StepState }[] }) {
  return (
    <ul className="steplist">
      {steps.map((s) => (
        <li key={s.id} className={`step step-${s.state}`}>
          <span className="step-dot" aria-hidden>{STEP_GLYPH[s.state]}</span>
          <span className="step-name">{s.name}</span>
          <span className="step-state">{s.state}</span>
        </li>
      ))}
    </ul>
  )
}

export type TerminalLineTone = 'error' | 'warn' | 'info'

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export function terminalLineTone(text: string): TerminalLineTone {
  const line = stripAnsi(text).toLowerCase()
  if (/(^|\s)err!/.test(line) || /\b(fail|failed|failure|error|fatal|exception|traceback|panic)\b/.test(line)) return 'error'
  if (/\b(warn|warning|deprecated|deprecation)\b/.test(line)) return 'warn'
  return 'info'
}

function terminalSegments(lines: string[]): { text: string; tone: TerminalLineTone }[] {
  const text = lines.join('')
  return text.match(/[^\n]*\n|[^\n]+/g)?.map((segment) => ({
    text: segment,
    tone: terminalLineTone(segment),
  })) ?? []
}

export function Terminal({ lines, caret }: { lines: string[]; caret?: boolean }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight)
  }, [lines])
  return (
    <pre className="terminal" ref={ref}>
      {terminalSegments(lines).map((segment, idx) => (
        <span key={`${idx}-${segment.tone}`} className={`terminal-line ${segment.tone}`}>{segment.text}</span>
      ))}
      {caret ? <span className="terminal-caret">▋</span> : null}
    </pre>
  )
}

export function StatusRow({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return (
    <div className={`statusrow ${ok === null ? 'pending' : ok ? 'ok' : 'bad'}`}>
      <span className="statusrow-icon" aria-hidden>{ok === null ? '…' : ok ? '✓' : '✗'}</span>
      <span className="statusrow-label">{label}</span>
      {detail ? <span className="statusrow-detail">{detail}</span> : null}
    </div>
  )
}
