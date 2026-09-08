'use client'

import { useSyncExternalStore } from 'react'
import { Tooltip } from './Tooltip'

const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false
const compactFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const fullFormat = new Intl.DateTimeFormat([], { dateStyle: 'full', timeStyle: 'long' })

/** Localize only after hydration: Docker and the browser may use different zones. */
export function MemoryTimeCell({ value }: { value: string }) {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
  const date = new Date(value)
  const valid = !Number.isNaN(date.getTime())
  const compact = !valid ? 'Unknown' : hydrated
    ? compactFormat.format(date)
    : date.toISOString().slice(0, 10)
  const full = valid && hydrated
    ? fullFormat.format(date)
    : value
  return (
    <Tooltip as="div" className="memory-time-cell" label={full}>
      <time dateTime={value}>{compact}</time>
    </Tooltip>
  )
}
