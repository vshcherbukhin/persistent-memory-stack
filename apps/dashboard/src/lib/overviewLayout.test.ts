import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OverviewLayout } from '../app/(dashboard)/OverviewLayout'
import {
  completeOverviewGesture,
  decodeOverviewLayout,
  defaultOverviewLayout,
  loadOverviewLayout,
  moveOverviewCard,
  overviewCardWidth,
  overviewDropTarget,
  overviewLayoutKey,
  overviewMoveKey,
  overviewResizeKey,
  resizeOverviewCard,
  saveOverviewLayout,
  type OverviewCardId,
} from './overviewLayout'

const ids: OverviewCardId[] = ['memories', 'services', 'sessions', 'workers', 'usage', 'graph', 'fact-extraction', 'embeddings', 'live-mcp', 'corpus']
const defaults = () => defaultOverviewLayout(ids)

describe('Overview widths and order', () => {
  it('defaults to three metrics and equal halves for both models and lower panels', () => {
    const layout = defaults()
    expect(overviewCardWidth('memories', 1_600, layout)).toBe(520)
    expect(overviewCardWidth('services', 1_600, layout)).toBe(520)
    for (const id of ['fact-extraction', 'embeddings', 'live-mcp', 'corpus'] as const) {
      expect(overviewCardWidth(id, 1_600, layout)).toBe(790)
    }
  })

  it('reduces columns at meaningful floors and never makes a card wider than its row', () => {
    expect(overviewCardWidth('memories', 600, defaults())).toBe(600)
    expect(overviewCardWidth('live-mcp', 600, defaults())).toBe(600)
    expect(overviewCardWidth('live-mcp', 320, defaults())).toBe(320)
    for (const width of [200, 390, 800, 1_280, 3_840]) {
      for (const id of ids) expect(overviewCardWidth(id, width, defaults())).toBeLessThanOrEqual(width)
    }
    expect(overviewCardWidth('memories', 0, defaults())).toBe(0)
  })

  it('keeps unsized lower cards equally wide at 1200 and wide rows while explicit widths respect each content floor', () => {
    const layout = defaults()
    expect(overviewCardWidth('live-mcp', 1_200, layout)).toBe(1_200)
    expect(overviewCardWidth('corpus', 1_200, layout)).toBe(1_200)
    expect(overviewCardWidth('fact-extraction', 1_200, layout)).toBe(590)
    expect(overviewCardWidth('embeddings', 1_200, layout)).toBe(590)
    const narrowed = resizeOverviewCard(layout, 'live-mcp', 360, 1_200)
    expect(overviewCardWidth('live-mcp', 1_200, narrowed)).toBe(720)
    const corpus = resizeOverviewCard(layout, 'corpus', 100, 1_200)
    expect(overviewCardWidth('corpus', 1_200, corpus)).toBe(360)
    expect(overviewCardWidth('memories', 1_201, layout) * 3 + 40).toBeLessThanOrEqual(1_201)
  })

  it('clamps resizing, preserves the preference through responsive measurements, and allows the full row', () => {
    const large = resizeOverviewCard(defaults(), 'live-mcp', 9_000, 1_000)
    expect(large.widths['live-mcp']).toBe(1)
    const small = resizeOverviewCard(defaults(), 'memories', 5, 1_000)
    expect(overviewCardWidth('memories', 1_000, small)).toBe(340)
    const saved = resizeOverviewCard(defaults(), 'live-mcp', 800, 1_000)
    expect(overviewCardWidth('live-mcp', 320, saved)).toBe(320)
    expect(overviewCardWidth('live-mcp', 1_000, saved)).toBe(800)
    expect(saved.widths['live-mcp']).toBe(.8)
    expect(resizeOverviewCard(saved, 'live-mcp', NaN, 1_000)).toBe(saved)
  })

  it('moves freely across metric, model and lower-panel categories without dropping cards', () => {
    const layout = moveOverviewCard(defaults(), 'corpus', 'memories', 'before')
    expect(layout.order[0]).toBe('corpus')
    const moved = moveOverviewCard(layout, 'services', 'embeddings', 'after')
    expect(moved.order.indexOf('services')).toBe(moved.order.indexOf('embeddings') + 1)
    expect(new Set(moved.order)).toEqual(new Set(ids))
    expect(moveOverviewCard(layout, 'corpus', 'corpus', 'after')).toBe(layout)
  })

  it('offers keyboard moves and width adjustments including first/last and min/max', () => {
    expect(overviewMoveKey(defaults(), 'corpus', 'Home')!.order[0]).toBe('corpus')
    expect(overviewMoveKey(defaults(), 'memories', 'End')!.order.at(-1)).toBe('memories')
    expect(overviewMoveKey(defaults(), 'services', 'ArrowUp')!.order[0]).toBe('services')
    expect(overviewMoveKey(defaults(), 'memories', 'ArrowDown')!.order[1]).toBe('memories')
    const layout = defaults()
    expect(overviewMoveKey(layout, 'memories', 'ArrowLeft')).toBe(layout)
    expect(overviewMoveKey(layout, 'memories', 'Tab')).toBeNull()
    expect(overviewResizeKey('ArrowLeft', 500, 'live-mcp', 1_000)).toBe(476)
    expect(overviewResizeKey('ArrowRight', 500, 'live-mcp', 1_000)).toBe(524)
    expect(overviewResizeKey('Home', 500, 'live-mcp', 1_000)).toBe(720)
    expect(overviewResizeKey('End', 500, 'live-mcp', 1_000)).toBe(1_000)
  })
})

describe('identity-scoped automatic layout persistence', () => {
  const identity = { userId: 'synthetic-owner', teamId: 'synthetic-personal-space' }
  const key = overviewLayoutKey(identity)

  it('uses distinct keys for user and team identities, without ambiguous concatenation', () => {
    expect(key).not.toBe(overviewLayoutKey({ ...identity, userId: 'other-owner' }))
    expect(key).not.toBe(overviewLayoutKey({ ...identity, teamId: 'other-space' }))
    expect(overviewLayoutKey({ userId: 'a:b', teamId: 'c' })).not.toBe(overviewLayoutKey({ userId: 'a', teamId: 'b:c' }))
  })

  it('synchronously saves a completed change and restores it from retained browser storage after a fresh load', () => {
    const records = new Map<string, string>()
    const storage = { getItem: (name: string) => records.get(name) ?? null, setItem: vi.fn((name: string, value: string) => { records.set(name, value) }) }
    const firstLoad = loadOverviewLayout(storage, key, ids)
    expect(firstLoad.status).toBe('default')
    expect(storage.setItem).not.toHaveBeenCalled()
    const changed = resizeOverviewCard(moveOverviewCard(firstLoad.layout, 'corpus', 'memories', 'before'), 'corpus', 600, 1_000)
    expect(saveOverviewLayout(storage, key, changed)).toBe(true)
    expect(records.has(key)).toBe(true) // no debounce or pending effect before navigation/restart
    expect(loadOverviewLayout(storage, key, ids).layout).toEqual(changed)
    expect(loadOverviewLayout(storage, overviewLayoutKey({ ...identity, userId: 'other-owner' }), ids).status).toBe('default')
  })

  it('validates corrupt data and unknown versions without overwriting them during initial loading', () => {
    for (const raw of ['not json', 'null', JSON.stringify({ ...defaults(), order: ['memories', 'memories'] }),
      JSON.stringify({ ...defaults(), widths: { memories: 0 } }), JSON.stringify({ ...defaults(), widths: { corpus: 1.1 } }),
      JSON.stringify({ ...defaults(), order: ['unknown'] })]) {
      const storage = { getItem: () => raw, setItem: vi.fn() }
      expect(loadOverviewLayout(storage, key, ids).status).toBe('invalid')
      expect(storage.setItem).not.toHaveBeenCalled()
    }
    const storage = { getItem: () => JSON.stringify({ version: 200 }), setItem: vi.fn() }
    expect(loadOverviewLayout(storage, key, ids).status).toBe('unsupported')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('admits newly available cards in default order, filters absent cards, and persists restored defaults', () => {
    const raw = JSON.stringify({ version: 1, order: ['corpus', 'people', 'memories'], widths: { corpus: .75 } })
    const decoded = decodeOverviewLayout(raw, ids)
    expect(decoded.layout.order.slice(0, 2)).toEqual(['corpus', 'memories'])
    expect(decoded.layout.order).not.toContain('people')
    expect(decoded.layout.order).toHaveLength(ids.length)
    const storage = { getItem: () => raw, setItem: vi.fn() }
    expect(saveOverviewLayout(storage, key, defaults())).toBe(true)
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual(defaults())
  })

  it('reports blocked browser storage honestly and refuses malformed writes', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    expect(loadOverviewLayout(blocked, key, ids).storageAvailable).toBe(false)
    expect(saveOverviewLayout(blocked, key, defaults())).toBe(false)
    const storage = { getItem: () => null, setItem: vi.fn() }
    expect(saveOverviewLayout(storage, key, { ...defaults(), widths: { corpus: Infinity } })).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})

describe('Overview gesture commits and unaffected card bodies', () => {
  const rects = [
    { id: 'memories' as const, left: 0, right: 320, top: 0, bottom: 200 },
    { id: 'services' as const, left: 340, right: 660, top: 0, bottom: 200 },
    { id: 'corpus' as const, left: 0, right: 490, top: 220, bottom: 500 },
  ]

  it('finds before/after targets across rows and rejects an outside drop', () => {
    expect(overviewDropTarget(rects, 350, 50)).toEqual({ id: 'services', edge: 'before' })
    expect(overviewDropTarget(rects, 650, 50)).toEqual({ id: 'services', edge: 'after' })
    expect(overviewDropTarget(rects, 480, 250)).toEqual({ id: 'corpus', edge: 'after' })
    expect(overviewDropTarget(rects, -200, 0)).toBeNull()
  })

  it('commits only a completed movement/resize, restoring a cancelled preview without a storage write', () => {
    const initial = defaults()
    const preview = resizeOverviewCard(initial, 'memories', 900, 1_000)
    const interaction = { kind: 'resize' as const, id: 'memories' as const, moved: true, cancelled: true, target: null }
    expect(completeOverviewGesture(initial, preview, interaction)).toEqual({ layout: initial, commit: false })
    expect(completeOverviewGesture(initial, preview, { ...interaction, cancelled: false })).toEqual({ layout: preview, commit: true })
    expect(completeOverviewGesture(initial, preview, { ...interaction, cancelled: false, moved: false }).commit).toBe(false)
    expect(completeOverviewGesture(initial, initial, { ...interaction, kind: 'move', cancelled: false }).commit).toBe(false)
    const moved = completeOverviewGesture(initial, initial, { ...interaction, kind: 'move', cancelled: false, target: { id: 'corpus', edge: 'after' } })
    expect(moved.commit).toBe(true)
    expect(moved.layout.order.indexOf('memories')).toBe(moved.layout.order.indexOf('corpus') + 1)
  })

  it('keeps links intact with a focusable card and right-edge resize control, without position labels or tool rows', () => {
    const html = renderToStaticMarkup(createElement(OverviewLayout, {
      identity: { userId: 'synthetic-owner', teamId: null },
      cards: [{ id: 'memories', content: createElement('a', { href: '/memories' }, 'Saved memories detail') }],
    }))
    expect(html).toContain('aria-label="Saved Memories"')
    expect(html).toContain('aria-keyshortcuts="Alt+ArrowLeft')
    expect(html).toContain('aria-label="Resize Saved Memories"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('<a href="/memories">Saved memories detail</a>')
    expect(html).not.toContain('draggable=')
    expect(html).not.toContain('Position ')
    expect(html).not.toContain('overview-layout-card-tools')
    expect(html).toContain('overview-layout-sr-only')
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.overview-layout-item\s*\{[^}]*max-width:\s*100%/s)
    expect(css).toMatch(/\.overview-layout-scroll\s*\{[^}]*overflow-x:\s*auto/s)
    expect(css).toMatch(/\.mcp-live-table\s*\{[^}]*min-width:\s*676px/s)
    expect(css).toMatch(/\.overview-layout-sr-only\s*\{[^}]*clip-path:\s*inset\(50%\)/s)
    expect(css).toMatch(/\.overview-resize-handle \.ui-icon\s*\{[^}]*top:\s*50%[^}]*opacity:\s*0/s)
    expect(css).toMatch(/\.overview-layout-grid\.dragging \.overview-layout-scroll\s*\{[^}]*visibility:\s*hidden/s)
  })
})
