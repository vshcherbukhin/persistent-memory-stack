'use client'

import { useEffect, useState } from 'react'
import {
  MEMORY_ACTIVITY_OPERATIONS,
  memoryActivityLabel,
  startMemoryActivityPolling,
  type MemoryActivitySnapshot,
} from '@/lib/memoryActivity'
import { Tooltip } from './ui/Tooltip'

export function MemoryActivityPills({ snapshot }: { snapshot: MemoryActivitySnapshot | null }) {
  return MEMORY_ACTIVITY_OPERATIONS.map((operation) => {
    const status = snapshot?.[operation] ?? null
    const state = status ? (status.active > 0 ? 'active' : status.state) : 'unavailable'
    const label = memoryActivityLabel(operation, status)
    return (
      <Tooltip key={operation} label={`Memory ${operation}: ${label}. Completed activity stays visible for 8 seconds.`} tabIndex={0}>
        <span className={`memory-activity-pill ${state}`} data-memory-operation={operation}>
          <i className="memory-activity-dot" aria-hidden="true" />
          <span>memory {operation} <span className="memory-activity-value">· {label}</span></span>
        </span>
      </Tooltip>
    )
  })
}

export function MemoryActivityIndicators() {
  const [snapshot, setSnapshot] = useState<MemoryActivitySnapshot | null>(null)
  useEffect(() => startMemoryActivityPolling({
    request: async (signal) => {
      const response = await fetch('/api/memory-activity', { cache: 'no-store', signal })
      if (!response.ok) throw new Error('memory_activity_unavailable')
      return response.json()
    },
    isVisible: () => document.visibilityState === 'visible',
    subscribeVisibility: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
    onChange: setSnapshot,
  }), [])
  return <MemoryActivityPills snapshot={snapshot} />
}
