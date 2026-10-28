import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryActivityPills } from '../components/MemoryActivityIndicators'
import {
  MEMORY_ACTIVITY_POLL_MS,
  MEMORY_ACTIVITY_TIMEOUT_MS,
  memoryActivityLabel,
  parseMemoryActivity,
  startMemoryActivityPolling,
  type MemoryActivitySnapshot,
} from './memoryActivity'

const snapshot: MemoryActivitySnapshot = {
  read: { active: 0, state: 'idle', lastCompletedAt: null },
  write: { active: 0, state: 'success', lastCompletedAt: '2026-10-28T10:00:00Z' },
  update: { active: 0, state: 'starting', lastCompletedAt: null },
}

afterEach(() => vi.useRealTimers())

describe('memory activity observations', () => {
  it('rejects partial, malformed or unknown activity instead of inventing green', () => {
    expect(parseMemoryActivity(snapshot)).toEqual(snapshot)
    for (const value of [null, {}, { ...snapshot, read: null },
      { ...snapshot, read: { ...snapshot.read, active: -1 } },
      { ...snapshot, read: { ...snapshot.read, state: 'healthy' } },
      { ...snapshot, read: { ...snapshot.read, lastCompletedAt: 'not-a-date' } }]) {
      expect(parseMemoryActivity(value)).toBeNull()
    }
  })

  it('names actual operations, overlap, completion, starting and unavailability explicitly', () => {
    expect(memoryActivityLabel('read', { ...snapshot.read, state: 'active', active: 2 })).toBe('reading (2)')
    expect(memoryActivityLabel('write', { ...snapshot.write, state: 'active', active: 1 })).toBe('writing')
    expect(memoryActivityLabel('update', { ...snapshot.update, state: 'active', active: 1 })).toBe('updating')
    expect(memoryActivityLabel('write', snapshot.write)).toBe('done')
    expect(memoryActivityLabel('update', snapshot.update)).toBe('starting')
    expect(memoryActivityLabel('read', null)).toBe('unavailable')
    expect(memoryActivityLabel('write', { ...snapshot.write, state: 'error' })).toBe('error')
  })

  it('renders read, write, update in order, and does not render an unknown sample as success', () => {
    const html = renderToStaticMarkup(createElement(MemoryActivityPills, { snapshot }))
    expect(html.indexOf('data-memory-operation="read"')).toBeLessThan(html.indexOf('data-memory-operation="write"'))
    expect(html.indexOf('data-memory-operation="write"')).toBeLessThan(html.indexOf('data-memory-operation="update"'))
    expect(html).toContain('· done')
    expect(html).toContain('tabindex="0"')
    const unknown = renderToStaticMarkup(createElement(MemoryActivityPills, { snapshot: null }))
    expect(unknown.match(/memory-activity-pill unavailable/g)).toHaveLength(3)
    expect(unknown).not.toContain('memory-activity-pill success')
  })

  it('keeps all four indicators below the header and allows the strip to wrap', () => {
    const header = readFileSync(new URL('../components/AppHeader.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
    const strip = header.slice(header.indexOf('className="header-status-strip"'))
    expect(header.indexOf('</header>')).toBeLessThan(header.indexOf('className="header-status-strip"'))
    expect(strip.indexOf('runtime-pill')).toBeLessThan(strip.indexOf('<MemoryActivityIndicators'))
    expect(css).toMatch(/\.header-status-strip\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(css).toContain('.header-status-strip .runtime-dot,')
  })
})

function harness(request: (signal: AbortSignal) => Promise<unknown>) {
  let visible = true
  let listener: (() => void) | undefined
  const unsubscribe = vi.fn(() => { listener = undefined })
  const onChange = vi.fn()
  const stop = startMemoryActivityPolling({
    request,
    isVisible: () => visible,
    subscribeVisibility: (next) => { listener = next; return unsubscribe },
    onChange,
  })
  return {
    stop, onChange, unsubscribe,
    visibility: (next: boolean) => { visible = next; listener?.() },
  }
}

describe('memory activity polling', () => {
  it('polls only after a response completes, with no overlapping request', async () => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    const request = vi.fn(() => new Promise((done) => { resolve = done }))
    const poller = harness(request)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(request).toHaveBeenCalledTimes(1)
    resolve(snapshot)
    await vi.advanceTimersByTimeAsync(0)
    expect(poller.onChange).toHaveBeenLastCalledWith(snapshot)
    await vi.advanceTimersByTimeAsync(MEMORY_ACTIVITY_POLL_MS - 1)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('aborts a stuck request and removes any prior green observation at the deadline', async () => {
    vi.useFakeTimers()
    let signal!: AbortSignal
    let resolve!: (value: unknown) => void
    const request = vi.fn<(input: AbortSignal) => Promise<unknown>>()
      .mockResolvedValueOnce(snapshot)
      .mockImplementation((input) => { signal = input; return new Promise((done) => { resolve = done }) })
    const poller = harness(request)
    await vi.advanceTimersByTimeAsync(MEMORY_ACTIVITY_POLL_MS)
    await vi.advanceTimersByTimeAsync(MEMORY_ACTIVITY_TIMEOUT_MS)
    expect(signal.aborted).toBe(true)
    expect(poller.onChange).toHaveBeenLastCalledWith(null)
    resolve(snapshot)
    await vi.advanceTimersByTimeAsync(0)
    expect(poller.onChange).toHaveBeenLastCalledWith(null)
    poller.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('suspends and invalidates a hidden tab, resumes visibly, and cleans up', async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockResolvedValue(snapshot)
    const poller = harness(request)
    await vi.advanceTimersByTimeAsync(0)
    poller.visibility(false)
    expect(poller.onChange).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request).toHaveBeenCalledTimes(1)
    poller.visibility(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(2)
    poller.stop()
    expect(poller.unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports failed and invalid samples as unavailable and aborts on unmount', async () => {
    vi.useFakeTimers()
    let signal!: AbortSignal
    const request = vi.fn<(input: AbortSignal) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({})
      .mockImplementation((input) => { signal = input; return new Promise(() => {}) })
    const poller = harness(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(poller.onChange).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(MEMORY_ACTIVITY_POLL_MS)
    expect(poller.onChange).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(MEMORY_ACTIVITY_POLL_MS)
    const calls = poller.onChange.mock.calls.length
    poller.stop()
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(poller.onChange).toHaveBeenCalledTimes(calls)
  })
})
