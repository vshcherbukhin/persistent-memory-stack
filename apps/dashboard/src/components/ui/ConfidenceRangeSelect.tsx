'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { adjustConfidenceRange, type ConfidenceRange } from './confidenceRange'

const STEP = 0.1

/**
 * A dialog-style extension of the portal-aware Select control. The interactive
 * +/- controls intentionally use a dialog instead of listbox options.
 */
export function ConfidenceRangeSelect({ min, max, onChange }: { min: string; max: string; onChange: (range: ConfidenceRange) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ConfidenceRange>({ min, max })
  const [style, setStyle] = useState<{ top: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const panelHeight = panelRef.current?.offsetHeight ?? 126
    const spaceBelow = window.innerHeight - rect.bottom - 5
    const spaceAbove = rect.top - 5
    const upward = spaceBelow < panelHeight && spaceAbove > spaceBelow
    setStyle({
      top: upward ? Math.max(5, rect.top - panelHeight - 5) : rect.bottom + 5,
      left: Math.min(rect.left, Math.max(5, window.innerWidth - 236)),
      width: Math.max(rect.width, 224),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    setDraft({ min, max })
    updatePosition()
  }, [max, min, open, updatePosition])

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  const minValue = Number(draft.min)
  const maxValue = Number(draft.max)
  const change = (key: keyof ConfidenceRange, direction: -1 | 1) => {
    const next = adjustConfidenceRange(draft, key, direction)
    setDraft(next)
    onChange(next)
  }
  const panel = open ? (
    <div
      ref={panelRef}
      className="ui-select-list ui-select-portal confidence-range-panel"
      role="dialog"
      aria-label="Confidence range"
      style={{ top: style?.top ?? 0, left: style?.left ?? 0, width: style?.width, visibility: style ? 'visible' : 'hidden' }}
    >
      <ConfidenceStep label="Min" value={draft.min} onDecrease={() => change('min', -1)} onIncrease={() => change('min', 1)} disableDecrease={minValue <= 0} disableIncrease={minValue + STEP > maxValue} />
      <ConfidenceStep label="Max" value={draft.max} onDecrease={() => change('max', -1)} onIncrease={() => change('max', 1)} disableDecrease={maxValue - STEP < minValue} disableIncrease={maxValue >= 1} />
    </div>
  ) : null

  return (
    <div className="ui-select confidence-range-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-select-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Filter by confidence range"
        onClick={() => setOpen((current) => !current)}
      >
        <span>Confidence {min} – {max}</span>
        <span className="ui-select-caret" aria-hidden><Icon name="keyboard_arrow_down" size={18} /></span>
      </button>
      {panel && typeof document !== 'undefined' ? createPortal(panel, document.body) : null}
    </div>
  )
}

function ConfidenceStep({ label, value, onDecrease, onIncrease, disableDecrease, disableIncrease }: {
  label: string
  value: string
  onDecrease: () => void
  onIncrease: () => void
  disableDecrease: boolean
  disableIncrease: boolean
}) {
  return (
    <div className="confidence-range-step">
      <span>{label}</span>
      <button type="button" className="confidence-step-button" aria-label={`Decrease ${label.toLowerCase()} confidence`} disabled={disableDecrease} onClick={onDecrease}><Icon name="remove" size={14} /></button>
      <output aria-label={`${label} confidence`}>{value}</output>
      <button type="button" className="confidence-step-button" aria-label={`Increase ${label.toLowerCase()} confidence`} disabled={disableIncrease} onClick={onIncrease}><Icon name="add" size={14} /></button>
    </div>
  )
}
