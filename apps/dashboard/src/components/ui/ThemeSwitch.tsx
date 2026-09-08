'use client'

import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_CHANGE_EVENT,
  THEME_OPTIONS,
  applyThemePreference,
  readThemePreference,
  storeThemePreference,
  type ThemePreference,
} from '@/lib/theme'

const OPTION_ICON: Record<ThemePreference, IconName> = {
  obsidian: 'dark_mode',
  porcelain: 'light_mode',
  system: 'contrast',
}

/**
 * Appearance control. Rendered in System Settings and in the profile modal, so a
 * member who cannot open superuser settings can still change their own theme.
 */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  // Server render and first client render must agree; the real preference is read
  // in an effect. The <html> stamp already shows the right theme by then.
  const [preference, setPreference] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setPreference(readThemePreference())
    setReady(true)
    const sync = (event: Event) => {
      const next = (event as CustomEvent<ThemePreference>).detail
      if (next) setPreference(next)
    }
    window.addEventListener(THEME_CHANGE_EVENT, sync)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync)
  }, [])

  useEffect(() => {
    if (!ready || preference !== 'system') return
    // Only a "system" preference has to react to the OS changing under us.
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const reapply = () => applyThemePreference('system')
    query.addEventListener('change', reapply)
    return () => query.removeEventListener('change', reapply)
  }, [preference, ready])

  const choose = (value: ThemePreference) => {
    setPreference(value)
    storeThemePreference(value)
  }

  return (
    <div className={`theme-switch${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Dashboard appearance">
      {THEME_OPTIONS.map((option) => {
        const selected = ready && option.value === preference
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`theme-switch-option${selected ? ' active' : ''}`}
            onClick={() => choose(option.value)}
          >
            <span className="theme-switch-swatch" data-variant={option.value} aria-hidden="true">
              <Icon name={OPTION_ICON[option.value]} size={compact ? 15 : 17} />
            </span>
            <span className="theme-switch-text">
              <span className="theme-switch-label">{option.label}</span>
              {compact ? null : <small>{option.description}</small>}
            </span>
          </button>
        )
      })}
    </div>
  )
}
