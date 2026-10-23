/** Browser-session state. Never serialize memory contents or passphrases to storage. */
export function createMemoryToolsStore() {
  const values = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  return {
    get<T>(key: string, initial: T): T {
      return values.has(key) ? values.get(key) as T : initial
    },
    set<T>(key: string, initial: T, next: T | ((previous: T) => T)) {
      const previous = values.has(key) ? values.get(key) as T : initial
      const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next
      if (Object.is(previous, value)) return
      values.set(key, value)
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
