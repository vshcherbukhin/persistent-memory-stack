'use client'

import { useRef, useSyncExternalStore } from 'react'
import { Icon, type IconName } from './Icon'
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_OPTIONS,
  readThemePreference,
  storeThemePreference,
  subscribeThemePreference,
  type ThemePreference,
} from '@/lib/theme'

const OPTION_ICON: Record<ThemePreference, IconName> = {
  obsidian: 'dark_mode',
  porcelain: 'light_mode',
  system: 'contrast',
}
const serverPreference = () => DEFAULT_THEME_PREFERENCE

/**
 * Appearance control. Rendered in System Settings and in the profile modal, so a
 * member who cannot open superuser settings can still change their own theme.
 */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  // A stable server snapshot keeps server markup and first hydration consistent.
  const preference = useSyncExternalStore(subscribeThemePreference, readThemePreference, serverPreference)
  const buttons = useRef<Partial<Record<ThemePreference, HTMLButtonElement>>>({})

  return (
    <div className={`theme-switch${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Dashboard appearance">
      {THEME_OPTIONS.map((option, index) => {
        const selected = option.value === preference
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            ref={(button) => { if (button) buttons.current[option.value] = button; else delete buttons.current[option.value] }}
            className={`theme-switch-option${selected ? ' active' : ''}`}
            onClick={() => storeThemePreference(option.value)}
            onKeyDown={(event) => {
              const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
              const target = event.key === 'Home' ? 0 : event.key === 'End' ? THEME_OPTIONS.length - 1 : direction ? (index + direction + THEME_OPTIONS.length) % THEME_OPTIONS.length : null
              if (target === null) return
              event.preventDefault()
              const value = THEME_OPTIONS[target]!.value
              storeThemePreference(value)
              buttons.current[value]?.focus()
            }}
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
