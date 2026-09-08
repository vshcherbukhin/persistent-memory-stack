import { describe, expect, it, vi } from 'vitest'
import { dashboardThemeUrl } from '../web/src/theme'

describe('wizard appearance handoff', () => {
  it('carries appearance between ports without losing the dashboard destination', () => {
    const url = new URL(dashboardThemeUrl('http://127.0.0.1:3200/?space=personal#overview', 'porcelain'))
    expect(url.origin).toBe('http://127.0.0.1:3200')
    expect(url.searchParams.get('pmTheme')).toBe('porcelain')
    expect(url.searchParams.get('space')).toBe('personal')
    expect(url.hash).toBe('#overview')
  })
  it('replaces an old handoff and limits the value to supported themes', () => {
    expect(new URL(dashboardThemeUrl('http://localhost:3200/?pmTheme=porcelain', 'obsidian')).searchParams.getAll('pmTheme')).toEqual(['obsidian'])
    expect(new URL(dashboardThemeUrl('http://localhost:3200/', 'invalid' as never)).searchParams.get('pmTheme')).toBe('obsidian')
  })
  it('hands off the displayed choice when browser storage refuses writes', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', { getItem: () => 'obsidian', setItem: () => { throw new Error('blocked') } })
    const setAttribute = vi.fn()
    vi.stubGlobal('document', { documentElement: { setAttribute } })
    try {
      const theme = await import('../web/src/theme')
      theme.applyTheme('porcelain')
      expect(setAttribute).toHaveBeenCalledWith('data-theme', 'porcelain')
      expect(new URL(theme.dashboardThemeUrl('http://localhost:3200/', theme.readTheme())).searchParams.get('pmTheme')).toBe('porcelain')
    } finally { vi.unstubAllGlobals(); vi.resetModules() }
  })
})
