export type MemoryActivityOperation = 'read' | 'write' | 'update'
export type MemoryActivityState = 'idle' | 'active' | 'success' | 'error' | 'starting'

export interface MemoryActivityStatus {
  active: number
  state: MemoryActivityState
  lastCompletedAt: string | null
}

export type MemoryActivitySnapshot = Record<MemoryActivityOperation, MemoryActivityStatus>

export const MEMORY_ACTIVITY_OPERATIONS: MemoryActivityOperation[] = ['read', 'write', 'update']
export const MEMORY_ACTIVITY_POLL_MS = 1_000
export const MEMORY_ACTIVITY_TIMEOUT_MS = 3_000

const states = new Set<MemoryActivityState>(['idle', 'active', 'success', 'error', 'starting'])

/** Reject incomplete observations rather than presenting an invented idle/success state. */
export function parseMemoryActivity(value: unknown): MemoryActivitySnapshot | null {
  if (!value || typeof value !== 'object') return null
  const result = {} as MemoryActivitySnapshot
  for (const operation of MEMORY_ACTIVITY_OPERATIONS) {
    const item = (value as Record<string, unknown>)[operation]
    if (!item || typeof item !== 'object') return null
    const status = item as Record<string, unknown>
    if (!Number.isSafeInteger(status.active) || (status.active as number) < 0 ||
      !states.has(status.state as MemoryActivityState) ||
      !(status.lastCompletedAt === null ||
        (typeof status.lastCompletedAt === 'string' && Number.isFinite(Date.parse(status.lastCompletedAt))))) return null
    result[operation] = {
      active: status.active as number,
      state: status.state as MemoryActivityState,
      lastCompletedAt: status.lastCompletedAt as string | null,
    }
  }
  return result
}

const activeLabels: Record<MemoryActivityOperation, string> = { read: 'reading', write: 'writing', update: 'updating' }

export function memoryActivityLabel(operation: MemoryActivityOperation, status: MemoryActivityStatus | null): string {
  if (!status) return 'unavailable'
  if (status.active > 0 || status.state === 'active') {
    return `${activeLabels[operation]}${status.active > 1 ? ` (${status.active})` : ''}`
  }
  return status.state === 'success' ? 'done' : status.state
}

/** One request at a time; hidden tabs and failed/timed-out samples never retain green. */
export function startMemoryActivityPolling({
  request,
  isVisible,
  subscribeVisibility,
  onChange,
}: {
  request: (signal: AbortSignal) => Promise<unknown>
  isVisible: () => boolean
  subscribeVisibility: (listener: () => void) => () => void
  onChange: (snapshot: MemoryActivitySnapshot | null) => void
}): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let pending: AbortController | null = null

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const poll = async () => {
    if (disposed || pending || !isVisible()) return
    const controller = new AbortController()
    pending = controller
    const timeout = setTimeout(() => {
      if (!disposed && pending === controller) onChange(null)
      controller.abort()
    }, MEMORY_ACTIVITY_TIMEOUT_MS)
    deadline = timeout
    try {
      const payload = await request(controller.signal)
      if (!disposed && !controller.signal.aborted && isVisible()) onChange(parseMemoryActivity(payload))
    } catch {
      if (!disposed && isVisible()) onChange(null)
    } finally {
      clearTimeout(timeout)
      if (deadline === timeout) deadline = null
      pending = null
      if (!disposed && isVisible()) timer = setTimeout(() => void poll(), MEMORY_ACTIVITY_POLL_MS)
    }
  }
  const unsubscribe = subscribeVisibility(() => {
    clearTimer()
    if (!isVisible()) {
      if (deadline) clearTimeout(deadline)
      deadline = null
      pending?.abort()
      onChange(null)
    } else {
      void poll()
    }
  })
  void poll()
  return () => {
    disposed = true
    clearTimer()
    if (deadline) clearTimeout(deadline)
    deadline = null
    pending?.abort()
    unsubscribe()
  }
}
