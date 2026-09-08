/**
 * Dashboard appearance. Two product themes plus an option to follow the operating
 * system. The choice is a per-browser preference, not server state: the dashboard
 * is a local surface and a user may reasonably want a different appearance on a
 * laptop than on a docked monitor, without that leaking into shared settings.
 *
 * The resolved theme is stamped on <html data-theme> before first paint by
 * THEME_BOOT_SCRIPT so a reload never flashes the wrong background.
 */

export type ThemePreference = 'obsidian' | 'porcelain' | 'system'
export type ResolvedTheme = 'obsidian' | 'porcelain'

export const THEME_STORAGE_KEY = 'pm.theme'
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'obsidian'
export const THEME_CHANGE_EVENT = 'pm:theme-changed'
export const THEME_HANDOFF_QUERY = 'pmTheme'
const SYSTEM_QUERY = '(prefers-color-scheme: dark)'
let sessionPreference: ThemePreference | undefined
const subscribers = new Set<() => void>()
let synchronizationUsers = 0
let stopSynchronization: (() => void) | undefined

export const THEME_OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: 'obsidian', label: 'Obsidian', description: 'The default dark instrument theme.' },
  { value: 'porcelain', label: 'Porcelain', description: 'Light theme with the same palette relationships.' },
  { value: 'system', label: 'Match system', description: 'Follow this computer’s light or dark setting.' },
]

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'obsidian' || value === 'porcelain' || value === 'system'
}

/** Keep a tab's choice usable even when the browser refuses persistence. */
export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE
  if (sessionPreference) return sessionPreference
  // The pre-paint handoff may be newer than storage if setItem was refused.
  const bootPreference = typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme-preference')
  if (isThemePreference(bootPreference)) return bootPreference
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemePreference(stored)) return stored
  } catch { /* Private windows and blocked site data must not break the dashboard. */ }
  return DEFAULT_THEME_PREFERENCE
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'obsidian' : 'porcelain'
  return preference
}

function systemPrefersDark(): boolean {
  try { return typeof window.matchMedia === 'function' ? window.matchMedia(SYSTEM_QUERY).matches : true }
  catch { return true }
}

/** Stamp the resolved theme without changing the stored preference. */
export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const prefersDark = typeof window !== 'undefined' ? systemPrefersDark() : true
  const resolved = resolveTheme(preference, prefersDark)
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.setAttribute('data-theme-preference', preference)
  }
  return resolved
}

export function storeThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined' || !isThemePreference(preference)) return
  sessionPreference = preference
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // A stored preference is a convenience; failing to persist must not throw.
  }
  applyThemePreference(preference)
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }))
}

/** One-time handoff from the wizard's different origin; never accepts CSS or URLs. */
export function consumeThemeHandoff(): ThemePreference | null {
  if (typeof window === 'undefined') return null
  let url: URL
  try { url = new URL(window.location.href) } catch { return null }
  if (!url.searchParams.has(THEME_HANDOFF_QUERY)) return null
  const value = url.searchParams.get(THEME_HANDOFF_QUERY)
  url.searchParams.delete(THEME_HANDOFF_QUERY)
  try { window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`) } catch { /* Restricted history is nonfatal. */ }
  if (value !== 'obsidian' && value !== 'porcelain') return null
  storeThemePreference(value)
  return value
}

/** App-wide, reference-counted listeners survive settings/profile unmounts. */
export function startThemeSynchronization(): () => void {
  if (typeof window === 'undefined') return () => {}
  synchronizationUsers++
  if (synchronizationUsers === 1) {
    consumeThemeHandoff()
    sessionPreference = readThemePreference()
    const publish = (preference: ThemePreference) => {
      sessionPreference = preference
      applyThemePreference(preference)
      for (const subscriber of subscribers) subscriber()
    }
    const changed = (event: Event) => {
      const preference: unknown = (event as CustomEvent).detail
      if (isThemePreference(preference)) publish(preference)
    }
    const storage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
      let value: string | null
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return
        // Another tab's queued event can predate a more recent local selection.
        value = window.localStorage.getItem(THEME_STORAGE_KEY)
      } catch { return }
      publish(isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE)
    }
    let media: MediaQueryList | undefined
    try { if (typeof window.matchMedia === 'function') media = window.matchMedia(SYSTEM_QUERY) } catch { /* OS preference unavailable. */ }
    const systemChanged = () => {
      if (readThemePreference() === 'system') applyThemePreference('system')
    }
    window.addEventListener(THEME_CHANGE_EVENT, changed)
    window.addEventListener('storage', storage)
    if (media?.addEventListener) media.addEventListener('change', systemChanged)
    else media?.addListener?.(systemChanged)
    applyThemePreference(sessionPreference)
    stopSynchronization = () => {
      window.removeEventListener(THEME_CHANGE_EVENT, changed)
      window.removeEventListener('storage', storage)
      if (media?.removeEventListener) media.removeEventListener('change', systemChanged)
      else media?.removeListener?.(systemChanged)
    }
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    if (--synchronizationUsers === 0) { stopSynchronization?.(); stopSynchronization = undefined }
  }
}

export function subscribeThemePreference(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  const stop = startThemeSynchronization()
  return () => { subscribers.delete(subscriber); stop() }
}

/**
 * Runs before page content renders. Kept dependency-free and tiny; it is
 * inlined as a string so there is no request between paint and the stamp.
 */
export const THEME_BOOT_SCRIPT = `(function(){
var p='${DEFAULT_THEME_PREFERENCE}';
try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');if(s==='obsidian'||s==='porcelain'||s==='system')p=s;}catch(e){}
try{var u=new URL(window.location.href);if(u.searchParams.has('${THEME_HANDOFF_QUERY}')){
var h=u.searchParams.get('${THEME_HANDOFF_QUERY}');u.searchParams.delete('${THEME_HANDOFF_QUERY}');
try{window.history.replaceState(window.history.state,'',u.pathname+u.search+u.hash);}catch(e){}
if(h==='obsidian'||h==='porcelain'){p=h;try{localStorage.setItem('${THEME_STORAGE_KEY}',p);}catch(e){}}
}}catch(e){}
var t=p;if(p==='system'){var d=true;try{if(typeof window.matchMedia==='function')d=window.matchMedia('${SYSTEM_QUERY}').matches;}catch(e){}t=d?'obsidian':'porcelain';}
document.documentElement.setAttribute('data-theme',t);
document.documentElement.setAttribute('data-theme-preference',p);
})();`
