import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, KeyboardEvent, ButtonHTMLAttributes } from 'react'

const state = vi.hoisted(() => ({ preference: 'obsidian' as 'obsidian' | 'porcelain' | 'system' }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => string) => getSnapshot(),
  useRef: () => ({ current: {} }),
}))
vi.mock('@/lib/theme', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/theme')>(),
  readThemePreference: () => state.preference,
  storeThemePreference: vi.fn((value: typeof state.preference) => { state.preference = value }),
}))

import { ThemeSwitch } from './ThemeSwitch'
import { storeThemePreference } from '@/lib/theme'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref: (button: HTMLButtonElement) => void }
function control() {
  const rendered = ThemeSwitch({})
  const buttons = rendered.props.children as ReactElement<ButtonProps>[]
  const focus = buttons.map(button => {
    const focus = vi.fn()
    button.props.ref({ focus } as unknown as HTMLButtonElement)
    return focus
  })
  return { buttons, focus }
}
beforeEach(() => { state.preference = 'obsidian'; vi.clearAllMocks() })

describe('appearance radio keyboard behavior', () => {
  it('makes only the selected option a tab stop and exposes one checked radio', () => {
    state.preference = 'porcelain'
    const { buttons } = control()
    expect(buttons.map(button => button.props.tabIndex)).toEqual([-1, 0, -1])
    expect(buttons.map(button => button.props['aria-checked'])).toEqual([false, true, false])
    expect(buttons.every(button => button.props.role === 'radio')).toBe(true)
  })

  it.each([
    [0, 'ArrowRight', 1, 'porcelain'], [0, 'ArrowDown', 1, 'porcelain'],
    [0, 'ArrowLeft', 2, 'system'], [0, 'ArrowUp', 2, 'system'],
    [2, 'ArrowRight', 0, 'obsidian'], [1, 'Home', 0, 'obsidian'], [1, 'End', 2, 'system'],
  ] as const)('moves focus and selects from %s with %s', (index, key, target, preference) => {
    const { buttons, focus } = control()
    const preventDefault = vi.fn()
    buttons[index]!.props.onKeyDown!({ key, preventDefault } as unknown as KeyboardEvent<HTMLButtonElement>)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(storeThemePreference).toHaveBeenCalledWith(preference)
    expect(focus[target]).toHaveBeenCalledOnce()
    expect(focus.filter((_value, i) => i !== target).every(fn => fn.mock.calls.length === 0)).toBe(true)
    expect(control().buttons[target]!.props.tabIndex).toBe(0)
  })

  it('leaves Tab and native button Space activation to the browser', () => {
    const { buttons } = control()
    const preventDefault = vi.fn()
    for (const key of ['Tab', ' ', 'Escape']) buttons[1]!.props.onKeyDown!({ key, preventDefault } as unknown as KeyboardEvent<HTMLButtonElement>)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(storeThemePreference).not.toHaveBeenCalled()
    buttons[1]!.props.onClick!({} as never)
    expect(storeThemePreference).toHaveBeenCalledWith('porcelain')
  })
})
