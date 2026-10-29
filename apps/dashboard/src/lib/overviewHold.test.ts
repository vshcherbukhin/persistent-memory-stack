import { afterEach, describe, expect, it, vi } from 'vitest'
import { armOverviewHold, guardOverviewTouchScroll, OVERVIEW_HOLD_MS } from './overviewHold'

afterEach(() => vi.useRealTimers())

describe('Overview card hold activation', () => {
  it('activates once only after a full second, allowing minor hand movement', () => {
    vi.useFakeTimers()
    const activate = vi.fn()
    const hold = armOverviewHold(100, 200, activate)
    vi.advanceTimersByTime(OVERVIEW_HOLD_MS - 1)
    expect(activate).not.toHaveBeenCalled()
    expect(hold.move(103, 202)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(activate).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('a normal click, release outside, Escape or unmount cancellation never activates later', () => {
    vi.useFakeTimers()
    const activate = vi.fn()
    const hold = armOverviewHold(100, 200, activate)
    vi.advanceTimersByTime(300)
    hold.cancel()
    hold.cancel()
    vi.advanceTimersByTime(2_000)
    expect(activate).not.toHaveBeenCalled()
  })

  it('selection or scrolling before activation cancels the pending hold permanently', () => {
    vi.useFakeTimers()
    const activate = vi.fn()
    const hold = armOverviewHold(100, 200, activate)
    expect(hold.move(100, 207)).toBe(false)
    expect(hold.move(100, 200)).toBe(false)
    vi.advanceTimersByTime(2_000)
    expect(activate).not.toHaveBeenCalled()
  })

  it('allows touch scrolling before activation, blocks native panning during dragging, and removes the guard on completion', () => {
    const target = new EventTarget()
    const registration = vi.spyOn(target, 'addEventListener')
    let active = false
    const remove = guardOverviewTouchScroll(target, () => active)
    expect(registration).toHaveBeenCalledWith('touchmove', expect.any(Function), { passive: false })
    const before = new Event('touchmove', { cancelable: true })
    target.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(false)
    active = true
    const dragging = new Event('touchmove', { cancelable: true })
    target.dispatchEvent(dragging)
    expect(dragging.defaultPrevented).toBe(true)
    remove()
    const finished = new Event('touchmove', { cancelable: true })
    target.dispatchEvent(finished)
    expect(finished.defaultPrevented).toBe(false)
  })
})
