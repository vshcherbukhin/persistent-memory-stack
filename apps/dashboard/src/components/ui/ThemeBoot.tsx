'use client'

import { useEffect } from 'react'
import { startThemeSynchronization } from '@/lib/theme'

/**
 * Re-asserts the theme after hydration and keeps synchronization alive on every page.
 *
 * The inline script stamps <html data-theme> before page content renders. Restore
 * that stamp after hydration and retain OS/cross-tab listeners independently of
 * settings pages and profile dialogs.
 */
export function ThemeBoot() {
  useEffect(() => startThemeSynchronization(), [])
  return null
}
