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

export const THEME_OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: 'obsidian', label: 'Obsidian', description: 'The default dark instrument theme.' },
  { value: 'porcelain', label: 'Porcelain', description: 'Light theme with the same palette relationships.' },
  { value: 'system', label: 'Match system', description: 'Follow this computer’s light or dark setting.' },
]

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'obsidian' || value === 'porcelain' || value === 'system'
}

/** Read the stored preference. Returns the default when storage is unavailable. */
export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE
  } catch {
    // Private windows and blocked site data must not break the dashboard.
    return DEFAULT_THEME_PREFERENCE
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'obsidian' : 'porcelain'
  return preference
}

/** Stamp the resolved theme and notify listeners in this tab. */
export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const prefersDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
  const resolved = resolveTheme(preference, prefersDark)
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.setAttribute('data-theme-preference', preference)
  }
  return resolved
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // A stored preference is a convenience; failing to persist must not throw.
  }
  applyThemePreference(preference)
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }))
}

/**
 * Runs in <head> before the body renders. Kept dependency-free and tiny; it is
 * inlined as a string so there is no request between paint and the stamp.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var p=localStorage.getItem('${THEME_STORAGE_KEY}');
if(p!=='obsidian'&&p!=='porcelain'&&p!=='system')p='${DEFAULT_THEME_PREFERENCE}';
var t=p==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'obsidian':'porcelain'):p;
document.documentElement.setAttribute('data-theme',t);
document.documentElement.setAttribute('data-theme-preference',p);
}catch(e){document.documentElement.setAttribute('data-theme','${DEFAULT_THEME_PREFERENCE}');}})();`
