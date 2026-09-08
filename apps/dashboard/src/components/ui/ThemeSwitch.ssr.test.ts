import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeSwitch } from './ThemeSwitch'

afterEach(() => vi.unstubAllGlobals())

it('uses the same safe initial radio snapshot with and without browser globals', () => {
  const server = renderToStaticMarkup(createElement(ThemeSwitch))
  vi.stubGlobal('window', { get localStorage() { throw new Error('Storage must not be read for server/hydration snapshot') } })
  const hydrationSnapshot = renderToStaticMarkup(createElement(ThemeSwitch))
  expect(hydrationSnapshot).toBe(server)
  expect(server).toContain('role="radiogroup" aria-label="Dashboard appearance"')
  expect(server.match(/aria-checked="true"/g)).toHaveLength(1)
  expect(server.match(/tabindex="0"/g)).toHaveLength(1)
})
