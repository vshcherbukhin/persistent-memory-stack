export const OVERVIEW_HOLD_MS = 1_000
export const OVERVIEW_HOLD_SLOP = 6

/** Movement before the hold completes means ordinary selection/scrolling, not a drag. */
export function armOverviewHold(x: number, y: number, activate: () => void) {
  let pending = true
  const timer = setTimeout(() => {
    if (!pending) return
    pending = false
    activate()
  }, OVERVIEW_HOLD_MS)
  const cancel = () => { pending = false; clearTimeout(timer) }
  return {
    cancel,
    move(nextX: number, nextY: number) {
      if (Math.hypot(nextX - x, nextY - y) > OVERVIEW_HOLD_SLOP) cancel()
      return pending
    },
  }
}

/** Pointer capture does not cancel native touch panning. Register before movement,
 * but leave scrolling untouched until the one-second hold has actually activated.
 */
export function guardOverviewTouchScroll(target: EventTarget, isDragging: () => boolean) {
  const guard = (event: Event) => { if (isDragging() && event.cancelable) event.preventDefault() }
  target.addEventListener('touchmove', guard, { passive: false })
  return () => target.removeEventListener('touchmove', guard)
}
