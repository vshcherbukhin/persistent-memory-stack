'use client'

import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { createMemoryToolsStore } from '@/lib/memoryToolsStore'

const StoreContext = createContext<ReturnType<typeof createMemoryToolsStore> | null>(null)
const ScopeContext = createContext('')

/** The dashboard layout outlives page/tab navigation; its identity key resets on sign-out/team changes. */
export function MemoryToolsStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createMemoryToolsStore)
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function MemoryToolsScope({ scope, children }: { scope: string; children: ReactNode }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
}

export function useMemoryToolState<T>(name: string, initial: T, scopeOverride?: string): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(StoreContext)
  const scope = useContext(ScopeContext)
  const initialRef = useRef(initial)
  if (!store) throw new Error('Memory tools require the dashboard state provider.')
  const key = `${scopeOverride ?? scope}:${name}`
  const getSnapshot = useCallback(() => store.get(key, initialRef.current), [store, key])
  const getServerSnapshot = useCallback(() => initialRef.current, [])
  const value = useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot)
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => store.set(key, initialRef.current, next), [store, key])
  return [value, setValue]
}
