/**
 * Wizard appearance. The installer writes the same preference key the dashboard
 * reads (`pm.theme` in localStorage), so the theme a user picks during setup is
 * the theme the dashboard opens with after the handoff.
 *
 * Both surfaces are served from a loopback origin but on different ports, so the
 * value does not actually travel between them; matching the key simply means a
 * user who picks Porcelain here is not surprised when they later set it there.
 */
export type ThemePreference = 'obsidian' | 'porcelain'

export const THEME_STORAGE_KEY = 'pm.theme'
export const DEFAULT_THEME: ThemePreference = 'obsidian'

export function readTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'porcelain' ? 'porcelain' : DEFAULT_THEME
  } catch {
    // Blocked site data must never stop an install.
    return DEFAULT_THEME
  }
}

export function applyTheme(theme: ThemePreference): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Persisting is a convenience, not a requirement.
  }
}
