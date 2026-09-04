'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatLogTimestamp, parseLogEntries, type LogLevel, type LogTimeMode } from '@/lib/logFormat'

export function LogOutput({
  text,
  fallback,
  fallbackLevel,
  fallbackTimestamp,
  maxLines,
  variant = 'terminal',
  showTimeToggle = false,
  className,
  ariaLabel,
}: {
  text: string | null | undefined
  fallback?: string
  fallbackLevel?: LogLevel
  fallbackTimestamp?: string | null
  maxLines?: number
  variant?: 'preview' | 'terminal'
  showTimeToggle?: boolean
  className?: string
  ariaLabel?: string
}) {
  const [timeMode, setTimeMode] = useState<LogTimeMode>('local')
  const logLinesRef = useRef<HTMLPreElement | null>(null)
  const autoScrollRef = useRef(true)
  const shouldAutoScroll = variant === 'terminal'
  const stableFallbackTimestamp = useMemo(
    () => fallbackTimestamp ?? new Date().toISOString(),
    [fallbackTimestamp, text],
  )
  const entries = useMemo(
    () => parseLogEntries(text, { fallback, fallbackLevel, fallbackTimestamp: stableFallbackTimestamp, maxLines }),
    [text, fallback, fallbackLevel, stableFallbackTimestamp, maxLines],
  )
  const scrollToBottom = useCallback(() => {
    if (!shouldAutoScroll || !autoScrollRef.current) return
    const node = logLinesRef.current
    if (!node) return
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
  }, [shouldAutoScroll])
  const handleLogScroll = useCallback(() => {
    if (!shouldAutoScroll) return
    const node = logLinesRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    autoScrollRef.current = distanceFromBottom <= 24
  }, [shouldAutoScroll])

  useEffect(() => {
    if (!shouldAutoScroll) return
    autoScrollRef.current = true
    scrollToBottom()
  }, [shouldAutoScroll, scrollToBottom])

  useEffect(() => {
    scrollToBottom()
  }, [entries, scrollToBottom])

  return (
    <div className={`log-output log-output-${variant}${className ? ` ${className}` : ''}`}>
      {showTimeToggle ? (
        <div className="log-output-toolbar">
          <span>Time</span>
          <div className="log-time-toggle" role="group" aria-label="Log time display">
            <button
              type="button"
              className={timeMode === 'local' ? 'active' : ''}
              onClick={() => setTimeMode('local')}
            >
              Local
            </button>
            <button
              type="button"
              className={timeMode === 'server' ? 'active' : ''}
              onClick={() => setTimeMode('server')}
            >
              Server
            </button>
          </div>
        </div>
      ) : null}
      <pre
        ref={logLinesRef}
        className="log-output-lines"
        aria-label={ariaLabel}
        onScroll={handleLogScroll}
      >{entries.map((entry, index) => (
          <span className={`log-line log-line-${entry.level}`} key={`${index}-${entry.message.slice(0, 32)}`}>
            <span className="log-time">[{formatLogTimestamp(entry.timestamp, timeMode)}]</span>
            {' '}
            <span className={`log-level log-level-${entry.level}`}>[{entry.level.toUpperCase()}]</span>
            <span className="log-punctuation">: </span>
            <span className="log-message">{entry.message}</span>
          </span>
        ))}</pre>
    </div>
  )
}
