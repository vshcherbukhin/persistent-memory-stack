/**
 * Wizard appearance is stored on the installer's origin. The completion link
 * explicitly carries the selected theme to the dashboard's separate origin.
 */
export type ThemePreference = 'obsidian' | 'porcelain'

export const THEME_STORAGE_KEY = 'pm.theme'
export const DEFAULT_THEME: ThemePreference = 'obsidian'
let sessionTheme: ThemePreference | undefined

export function readTheme(): ThemePreference {
  if (sessionTheme) return sessionTheme
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'porcelain' ? 'porcelain' : DEFAULT_THEME
  } catch {
    // Blocked site data must never stop an install.
    return DEFAULT_THEME
  }
}

export function applyTheme(theme: ThemePreference): void {
  sessionTheme = theme
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Persisting is a convenience, not a requirement.
  }
}

/** Carry only the allowlisted appearance value, preserving dashboard routing. */
export function dashboardThemeUrl(dashboardUrl: string, theme: ThemePreference): string {
  const url = new URL(dashboardUrl)
  url.searchParams.set('pmTheme', theme === 'porcelain' ? 'porcelain' : 'obsidian')
  return url.toString()
}
