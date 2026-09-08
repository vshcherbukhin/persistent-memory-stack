'use client'

import { useEffect } from 'react'
import { applyThemePreference, readThemePreference } from '@/lib/theme'

/**
 * Re-asserts the stored theme after hydration.
 *
 * The inline boot script stamps <html data-theme> before first paint, but React
 * reconciles attributes on the <html> element it rendered, which drops a stamp it
 * did not produce. This component restores it on mount, so a full page load ends
 * on the user's theme rather than the server default.
 */
export function ThemeBoot() {
  useEffect(() => {
    applyThemePreference(readThemePreference())
  }, [])
  return null
}
