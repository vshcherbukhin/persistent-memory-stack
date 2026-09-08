import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'

function browserFixture({ stored, dark = true, href = 'http://localhost:3200/memories?filter=mine#graph' }: { stored?: string; dark?: boolean; href?: string } = {}) {
  const values = new Map(stored === undefined ? [] : [['pm.theme', stored]])
  const attributes = new Map<string, string>()
  const localStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
  }
  const media = Object.assign(new EventTarget(), { matches: dark })
  const location = { href }
  const history = {
    state: { existing: 'state' },
    replaceState: vi.fn((_state: unknown, _title: string, path: string) => { location.href = new URL(path, location.href).href }),
  }
  const window = Object.assign(new EventTarget(), { localStorage, matchMedia: vi.fn(() => media), location, history })
  const document = { documentElement: { setAttribute: (key: string, value: string) => attributes.set(key, value), getAttribute: (key: string) => attributes.get(key) ?? null } }
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  return {
    window, document, localStorage, attributes, media, values,
    osChange(dark: boolean) { media.matches = dark; media.dispatchEvent(new Event('change')) },
    storageChange(key: string | null, value: string | null, storageArea: unknown = localStorage) {
      if (storageArea === localStorage) {
        if (key === null) values.clear()
        else if (value === null) values.delete(key)
        else values.set(key, value)
      }
      window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: value, storageArea }))
    },
    boot(script: string) { runInNewContext(script, { window, document, localStorage, URL }) },
  }
}

let theme: typeof import('./theme')
let stops: (() => void)[]
beforeEach(async () => { vi.resetModules(); theme = await import('./theme'); stops = [] })
afterEach(() => { for (const stop of stops.reverse()) stop(); vi.unstubAllGlobals() })

describe('application-wide appearance', () => {
  it('follows OS changes with only ThemeBoot synchronization alive, including after controls unsubscribe', () => {
    const browser = browserFixture({ stored: 'system', dark: false })
    stops.push(theme.startThemeSynchronization())
    const stopControl = theme.subscribeThemePreference(vi.fn())
    stopControl()
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
    browser.osChange(true)
    expect(browser.attributes.get('data-theme')).toBe('obsidian')
    expect(theme.readThemePreference()).toBe('system')
    expect(browser.localStorage.setItem).not.toHaveBeenCalled()
  })

  it('keeps a manually selected theme when the operating system changes', () => {
    const browser = browserFixture({ stored: 'porcelain' })
    stops.push(theme.startThemeSynchronization())
    browser.osChange(false)
    browser.osChange(true)
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
  })

  it('synchronizes other tabs and mounted controls without writing preferences back', () => {
    const browser = browserFixture()
    const first = vi.fn()
    const second = vi.fn()
    stops.push(theme.subscribeThemePreference(first), theme.subscribeThemePreference(second))
    browser.storageChange('pm.theme', 'porcelain')
    expect(theme.readThemePreference()).toBe('porcelain')
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    browser.storageChange('pm.theme', 'system')
    browser.osChange(false)
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
    expect(theme.readThemePreference()).toBe('system')
    expect(browser.localStorage.setItem).not.toHaveBeenCalled()
  })

  it('notifies both appearance controls of a same-tab selection', () => {
    browserFixture()
    const first = vi.fn()
    const second = vi.fn()
    stops.push(theme.subscribeThemePreference(first), theme.subscribeThemePreference(second))
    theme.storeThemePreference('porcelain')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(theme.readThemePreference()).toBe('porcelain')
  })

  it('ignores stale storage event values after a newer local selection', () => {
    const browser = browserFixture()
    stops.push(theme.startThemeSynchronization())
    theme.storeThemePreference('obsidian')
    browser.window.dispatchEvent(Object.assign(new Event('storage'), { key: 'pm.theme', newValue: 'porcelain', storageArea: browser.localStorage }))
    expect(theme.readThemePreference()).toBe('obsidian')
    expect(browser.attributes.get('data-theme')).toBe('obsidian')
  })

  it.each([['pm.theme', null], [null, null], ['pm.theme', 'untrusted-value']] as const)('resets to the product default after storage removal/clear/invalid data (%s, %s)', (key, value) => {
    const browser = browserFixture({ stored: 'porcelain' })
    stops.push(theme.startThemeSynchronization())
    browser.storageChange(key, value)
    expect(theme.readThemePreference()).toBe('obsidian')
    expect(browser.attributes.get('data-theme')).toBe('obsidian')
  })

  it('ignores unrelated storage, sessionStorage and invalid same-tab events', () => {
    const browser = browserFixture({ stored: 'porcelain' })
    stops.push(theme.startThemeSynchronization())
    browser.storageChange('unrelated', 'obsidian')
    browser.storageChange('pm.theme', 'obsidian', {})
    browser.window.dispatchEvent(new CustomEvent(theme.THEME_CHANGE_EVENT, { detail: 'url(javascript:example)' }))
    expect(theme.readThemePreference()).toBe('porcelain')
  })

  it('retains a nonpersistent choice through navigation/remount when site storage is blocked', () => {
    const browser = browserFixture({ stored: 'obsidian', dark: false })
    browser.localStorage.setItem.mockImplementation(() => { throw new Error('blocked') })
    const stop = theme.startThemeSynchronization()
    theme.storeThemePreference('system')
    stop()
    stops.push(theme.startThemeSynchronization())
    expect(theme.readThemePreference()).toBe('system')
    browser.osChange(true)
    expect(browser.attributes.get('data-theme')).toBe('obsidian')
    expect(browser.attributes.get('data-theme-preference')).toBe('system')
  })

  it('shares one OS listener and cleans up exactly once after the final subscriber', () => {
    const browser = browserFixture({ stored: 'system' })
    const add = vi.spyOn(browser.media, 'addEventListener')
    const remove = vi.spyOn(browser.media, 'removeEventListener')
    const first = theme.startThemeSynchronization()
    const second = theme.startThemeSynchronization()
    expect(add).toHaveBeenCalledTimes(1)
    first(); first()
    expect(remove).not.toHaveBeenCalled()
    second()
    expect(remove).toHaveBeenCalledTimes(1)
    browser.osChange(false)
    expect(browser.attributes.get('data-theme')).toBe('obsidian')
    stops.push(theme.startThemeSynchronization())
    expect(add).toHaveBeenCalledTimes(2)
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
  })

  it('safely boots when storage and media queries are unavailable', () => {
    const browser = browserFixture()
    browser.localStorage.getItem.mockImplementation(() => { throw new Error('blocked') })
    browser.window.matchMedia.mockImplementation(() => { throw new Error('unavailable') })
    browser.boot(theme.THEME_BOOT_SCRIPT)
    stops.push(theme.startThemeSynchronization())
    expect(browser.attributes.get('data-theme')).toBe('obsidian')
    theme.storeThemePreference('porcelain')
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
  })

  it('keeps the system preference with a dark fallback if matchMedia is missing', () => {
    const browser = browserFixture({ stored: 'system' })
    Object.defineProperty(browser.window, 'matchMedia', { value: undefined })
    browser.boot(theme.THEME_BOOT_SCRIPT)
    stops.push(theme.startThemeSynchronization())
    expect(theme.readThemePreference()).toBe('system')
    expect(browser.attributes.get('data-theme')).toBe('obsidian')
  })
})

describe('one-time wizard appearance handoff', () => {
  it.each(['script', 'hydration'] as const)('applies an explicit handoff through %s without dropping unrelated URL state', (mode) => {
    const browser = browserFixture({ stored: 'obsidian', href: 'http://localhost:3200/login?next=%2Fmemories&pmTheme=porcelain#account' })
    if (mode === 'script') browser.boot(theme.THEME_BOOT_SCRIPT)
    stops.push(theme.startThemeSynchronization())
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
    expect(browser.values.get('pm.theme')).toBe('porcelain')
    expect(browser.window.location.href).toBe('http://localhost:3200/login?next=%2Fmemories#account')
    expect(browser.window.history.replaceState).toHaveBeenCalledWith({ existing: 'state' }, '', '/login?next=%2Fmemories#account')
    expect(theme.consumeThemeHandoff()).toBeNull()
  })

  it('keeps a handoff after hydration even when an older stored preference cannot be overwritten', () => {
    const browser = browserFixture({ stored: 'obsidian', href: 'http://localhost:3200/?pmTheme=porcelain' })
    browser.localStorage.setItem.mockImplementation(() => { throw new Error('blocked') })
    browser.boot(theme.THEME_BOOT_SCRIPT)
    stops.push(theme.startThemeSynchronization())
    expect(theme.readThemePreference()).toBe('porcelain')
    expect(browser.attributes.get('data-theme')).toBe('porcelain')
    expect(browser.values.get('pm.theme')).toBe('obsidian')
  })

  describe.each(['script', 'hydration'] as const)('%s validation', mode => {
    it.each(['system', 'PORCELAIN', 'url(javascript:example)', ''])('rejects invalid handoff %j', value => {
      const browser = browserFixture({ stored: 'porcelain', href: `http://localhost:3200/?keep=1&pmTheme=${encodeURIComponent(value)}#view` })
      if (mode === 'script') browser.boot(theme.THEME_BOOT_SCRIPT)
      stops.push(theme.startThemeSynchronization())
      expect(browser.attributes.get('data-theme')).toBe('porcelain')
      expect(browser.window.location.href).toBe('http://localhost:3200/?keep=1#view')
      expect(browser.localStorage.setItem).not.toHaveBeenCalled()
    })
  })

  it('does not need browser globals during server rendering', () => {
    expect(theme.readThemePreference()).toBe('obsidian')
    expect(theme.consumeThemeHandoff()).toBeNull()
    expect(() => theme.storeThemePreference('porcelain')).not.toThrow()
    expect(() => theme.startThemeSynchronization()()).not.toThrow()
  })
})
