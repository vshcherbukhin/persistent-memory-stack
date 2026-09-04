'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function timeValue(date: Date | null): string {
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '23:59'
}

function labelFor(value: string | null): string {
  if (!value) return 'Non-expiring'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Choose expiry'
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function daysInMonth(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1).getDay()
  const count = new Date(year, month + 1, 0).getDate()
  return [...Array(first).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)]
}

export function DateTimePicker({
  name,
  value,
  onChange,
  ariaLabel = 'Choose date and time',
}: {
  name: string
  value: string | null
  onChange: (value: string | null) => void
  ariaLabel?: string
}) {
  const selected = value ? new Date(value) : null
  const safeSelected = selected && !Number.isNaN(selected.getTime()) ? selected : null
  const [open, setOpen] = useState(false)
  const [monthDate, setMonthDate] = useState(() => safeSelected ?? new Date())
  const [time, setTime] = useState(() => timeValue(safeSelected))
  const [popoverStyle, setPopoverStyle] = useState<{ top: number; left: number; width: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const days = useMemo(() => daysInMonth(monthDate.getFullYear(), monthDate.getMonth()), [monthDate])

  const updatePopoverStyle = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPopoverStyle({
      top: rect.bottom + 6,
      left: rect.left,
      width: Math.max(292, rect.width),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    updatePopoverStyle()
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('resize', updatePopoverStyle)
    window.addEventListener('scroll', updatePopoverStyle, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('resize', updatePopoverStyle)
      window.removeEventListener('scroll', updatePopoverStyle, true)
    }
  }, [open, updatePopoverStyle])

  const commit = (day: number, nextTime = time) => {
    const [hoursRaw, minutesRaw] = nextTime.split(':')
    const hours = Number(hoursRaw)
    const minutes = Number(minutesRaw)
    const next = new Date(
      monthDate.getFullYear(),
      monthDate.getMonth(),
      day,
      Number.isFinite(hours) ? hours : 23,
      Number.isFinite(minutes) ? minutes : 59,
    )
    onChange(next.toISOString())
  }

  const changeTime = (next: string) => {
    setTime(next)
    if (!safeSelected || !/^\d{2}:\d{2}$/.test(next)) return
    const [hours, minutes] = next.split(':').map(Number)
    if (hours > 23 || minutes > 59) return
    const date = new Date(safeSelected)
    date.setHours(hours, minutes, 0, 0)
    onChange(date.toISOString())
  }

  const selectedDay =
    safeSelected &&
    safeSelected.getFullYear() === monthDate.getFullYear() &&
    safeSelected.getMonth() === monthDate.getMonth()
      ? safeSelected.getDate()
      : null

  const popover = open ? (
    <div
      ref={popoverRef}
      className="ui-datetime-popover ui-datetime-portal"
      style={{
        top: popoverStyle?.top ?? 0,
        left: popoverStyle?.left ?? 0,
        width: popoverStyle?.width ?? 292,
        visibility: popoverStyle ? 'visible' : 'hidden',
      }}
    >
      <div className="ui-datetime-head">
        <button
          type="button"
          className="secondary"
          aria-label="Previous month"
          onClick={() => setMonthDate((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <strong>{MONTHS[monthDate.getMonth()]} {monthDate.getFullYear()}</strong>
        <button
          type="button"
          className="secondary"
          aria-label="Next month"
          onClick={() => setMonthDate((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
        >
          ›
        </button>
      </div>
      <div className="ui-datetime-grid">
        {WEEKDAYS.map((weekday) => <span key={weekday} className="ui-datetime-weekday">{weekday}</span>)}
        {days.map((day, index) => day ? (
          <button
            key={day}
            type="button"
            className={`ui-datetime-day${day === selectedDay ? ' selected' : ''}`}
            onClick={() => commit(day)}
          >
            {day}
          </button>
        ) : <span key={`blank-${index}`} />)}
      </div>
      <label className="ui-datetime-time">
        Time
        <input
          type="text"
          inputMode="numeric"
          placeholder="23:59"
          value={time}
          onChange={(event) => changeTime(event.target.value)}
        />
      </label>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <button type="button" className="secondary" onClick={() => onChange(null)}>No expiry</button>
        <button type="button" onClick={() => setOpen(false)}>Done</button>
      </div>
    </div>
  ) : null

  return (
    <div className="ui-datetime" ref={ref}>
      <input type="hidden" name={name} value={value ?? ''} />
      <button
        ref={triggerRef}
        type="button"
        className="ui-datetime-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {labelFor(value)}
        <span className="ui-select-caret" aria-hidden>
          <Icon name="keyboard_arrow_down" size={18} />
        </span>
      </button>
      {popover && typeof document !== 'undefined' ? createPortal(popover, document.body) : null}
    </div>
  )
}
