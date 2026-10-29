'use client'

import { useEffect, useState } from 'react'
import {
  MEMORY_ACTIVITY_OPERATIONS,
  startMemoryActivityDotPolling,
  type MemoryActivityDots,
} from '@/lib/memoryActivity'
import { Tooltip } from './ui/Tooltip'

export function MemoryActivityPills({ dots }: { dots: MemoryActivityDots }) {
  return MEMORY_ACTIVITY_OPERATIONS.map((operation) => {
    return (
      <Tooltip key={operation} label={`Memory ${operation} activity`} tabIndex={0}>
        <span className="runtime-pill memory-activity-pill" data-memory-operation={operation}>
          <i className={`runtime-dot${dots[operation] ? ' blinking' : ''}`} aria-hidden="true" />
          <span>memory {operation}</span>
        </span>
      </Tooltip>
    )
  })
}

export function MemoryActivityIndicators() {
  const [dots, setDots] = useState<MemoryActivityDots>({ read: false, write: false, update: false })
  useEffect(() => startMemoryActivityDotPolling({
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
    onChange: setDots,
  }), [])
  return <MemoryActivityPills dots={dots} />
}
