import { describe, expect, it } from 'vitest'
import {
  decodeOverviewLayout, defaultOverviewLayout, validOverviewPlacements,
  type OverviewCardId, type OverviewLayoutState, type OverviewPlacement,
} from './overviewLayout'
import {
  moveOverviewPlacement, moveOverviewPlacementKey, overviewGridRows, overviewGridUnit,
  overviewMinimumSpan, overviewPlacementWidth, overviewResizeRange, resolveOverviewGrid,
  resizeOverviewPlacement, resizeOverviewPlacementKey,
} from './overviewGrid'

const ids: OverviewCardId[] = ['memories', 'services', 'sessions', 'workers', 'usage', 'graph', 'fact-extraction', 'embeddings', 'live-mcp', 'corpus']
const width = 1_600
const unit = overviewGridUnit(width)
const placement = (row: number, column: number, span: number): OverviewPlacement => ({ row, column, span })
function fixture(placements: Partial<Record<OverviewCardId, OverviewPlacement>>, widths: OverviewLayoutState['widths'] = {}): OverviewLayoutState {
  return { version: 2, order: Object.keys(placements) as OverviewCardId[], widths, placements }
}
function expectUnchangedPeers(before: OverviewLayoutState, after: OverviewLayoutState, changed: OverviewCardId[]) {
  for (const id of before.order.filter((candidate) => !changed.includes(candidate))) {
    expect(after.placements![id]).toEqual(before.placements![id])
    expect(after.widths[id]).toBe(before.widths[id])
  }
  expect(validOverviewPlacements(after.placements, after.order)).toBe(true)
}

describe('fixed Overview grid materialization', () => {
  it('packs default metrics in thirds and both pairs in equal halves when floors fit', () => {
    const layout = resolveOverviewGrid(defaultOverviewLayout(ids), width)
    expect(layout.placements!.memories).toEqual(placement(1, 1, 4))
    expect(layout.placements!.services).toEqual(placement(1, 5, 4))
    expect(layout.placements!.sessions).toEqual(placement(1, 9, 4))
    expect(layout.placements!['fact-extraction']).toEqual(placement(3, 1, 6))
    expect(layout.placements!.embeddings).toEqual(placement(3, 7, 6))
    expect(layout.placements!['live-mcp']).toEqual(placement(4, 1, 6))
    expect(layout.placements!.corpus).toEqual(placement(4, 7, 6))
    expect(overviewPlacementWidth(layout.placements!['live-mcp']!, width)).toBe(790)
    expect(overviewGridRows(layout)).toBe(4)
  })

  it('keeps default pairs equal at narrower widths and applies the exact gutter-aware minimum span', () => {
    const layout = resolveOverviewGrid(defaultOverviewLayout(ids), 1_200)
    expect(layout.placements!['fact-extraction']!.span).toBe(6)
    expect(layout.placements!.embeddings!.span).toBe(6)
    expect(layout.placements!['live-mcp']!.span).toBe(12)
    expect(layout.placements!.corpus!.span).toBe(12)
    expect(overviewMinimumSpan('live-mcp', 1_200)).toBe(Math.ceil((720 + 20) * 12 / (1_200 + 20)))
    expect(overviewMinimumSpan('memories', 320)).toBe(12)
    expect(overviewMinimumSpan('memories', 0)).toBe(12)
  })

  it('preserves the .37 v1 pixel fraction when packing, without backfilling earlier holes or changing raw widths', () => {
    const migrated = decodeOverviewLayout(JSON.stringify({ version: 1, order: ['memories', 'services', 'corpus'], widths: { memories: .37, services: .7, corpus: .3 } }), ['memories', 'services', 'corpus'])
    const result = resolveOverviewGrid(migrated.layout, width)
    expect(result.placements!.memories!.span).toBe(5) // 592px targets 655px, not the smaller 520px stop
    expect(result.placements!.services!.row).toBe(2)
    expect(result.placements!.corpus!.row).toBe(2)
    expect(result.order).toEqual(['memories', 'services', 'corpus'])
    expect(result.widths).toEqual({ memories: .37, services: .7, corpus: .3 })
    expect(migrated.layout.placements).toBeUndefined()
  })

  it('treats saved cells and holes as authoritative and appends new cards without packing away gaps', () => {
    const saved = fixture({ memories: placement(1, 1, 3), services: placement(1, 7, 6) }, { memories: .8 })
    const result = resolveOverviewGrid(saved, width)
    expect(result.placements).toEqual(saved.placements) // placement wins over contradictory old raw fraction
    const added = resolveOverviewGrid({ ...saved, order: [...saved.order, 'corpus'] }, width)
    expect(added.placements!.memories).toEqual(saved.placements!.memories)
    expect(added.placements!.services).toEqual(saved.placements!.services)
    expect(added.placements!.corpus!.row).toBe(2)
  })

  it('projects responsive floors without changing the stored positions and restores them at the original viewport', () => {
    const saved = fixture({ 'fact-extraction': placement(1, 1, 6), embeddings: placement(1, 7, 6), corpus: placement(3, 1, 6) }, { embeddings: .49 })
    const original = structuredClone(saved)
    const narrow = resolveOverviewGrid(saved, 1_000)
    expect(narrow.placements!['fact-extraction']).toEqual(placement(1, 1, 7))
    expect(narrow.placements!.embeddings!.row).toBe(2)
    expect(narrow.placements!.corpus).toEqual(saved.placements!.corpus)
    for (const id of saved.order) expect(narrow.placements![id]!.span).toBeGreaterThanOrEqual(overviewMinimumSpan(id, 1_000))
    expect(validOverviewPlacements(narrow.placements, narrow.order)).toBe(true)
    expect(saved).toEqual(original)
    expect(resolveOverviewGrid(saved, width).placements).toEqual(saved.placements)
    expect(narrow.widths).toEqual(saved.widths)
  })

  it('projects six small metrics plus model/lower pairs into compact rows at 1000 and390 without saving or changing visual order', () => {
    const placements: OverviewLayoutState['placements'] = {}
    for (const [index, id] of ids.slice(0, 6).entries()) placements[id] = placement(1, index * 2 + 1, 2)
    placements['fact-extraction'] = placement(2, 1, 6)
    placements.embeddings = placement(2, 7, 6)
    placements['live-mcp'] = placement(3, 1, 6)
    placements.corpus = placement(3, 7, 6)
    const saved = fixture(placements, { memories: .15, corpus: .49 })
    const original = structuredClone(saved)
    for (const viewport of [1_000, 390]) {
      const projected = resolveOverviewGrid(saved, viewport)
      expect(projected.order).toEqual(ids)
      expect(projected.placements!.memories!.row).toBe(1)
      expect(validOverviewPlacements(projected.placements, projected.order)).toBe(true)
      const rows = [...new Set(projected.order.map((id) => projected.placements![id]!.row))]
      expect(rows).toEqual(Array.from({ length: overviewGridRows(projected) }, (_, index) => index + 1))
      for (const id of ids) expect(projected.placements![id]!.span).toBeGreaterThanOrEqual(overviewMinimumSpan(id, viewport))
    }
    expect(saved).toEqual(original)
    expect(resolveOverviewGrid(saved, 2_330).placements).toEqual(saved.placements)
  })
})

describe('independent edge resizing', () => {
  it('moves a grabbed left edge while the right edge, row, all peers and their raw widths stay fixed', () => {
    const before = fixture({ memories: placement(1, 1, 3), services: placement(1, 5, 8), corpus: placement(2, 1, 6) }, { memories: .37, corpus: .49 })
    const after = resizeOverviewPlacement(before, 'services', 'left', 2 * unit, width)
    expect(after.placements!.services).toEqual(placement(1, 7, 6))
    expect(after.placements!.services!.column + after.placements!.services!.span).toBe(13)
    expectUnchangedPeers(before, after, ['services'])
    expect(after.order).toEqual(before.order)
  })

  it('moves a grabbed right edge while its left edge remains fixed, leaving the released cells empty', () => {
    const before = fixture({ memories: placement(1, 1, 6), services: placement(1, 7, 6) }, { services: .49 })
    const after = resizeOverviewPlacement(before, 'memories', 'right', -3 * unit, width)
    expect(after.placements!.memories).toEqual(placement(1, 1, 3))
    expectUnchangedPeers(before, after, ['memories'])
    const reloaded = decodeOverviewLayout(JSON.stringify(after), before.order).layout
    expect(resolveOverviewGrid(reloaded, width).placements).toEqual(after.placements)
  })

  it('clamps growth at occupied peers or the row boundary, with no resize, displacement or row jump', () => {
    const before = fixture({ memories: placement(1, 1, 6), services: placement(1, 7, 6), corpus: placement(2, 1, 6) })
    expect(resizeOverviewPlacement(before, 'memories', 'right', 100_000, width)).toBe(before)
    expect(resizeOverviewPlacement(before, 'services', 'left', -100_000, width)).toBe(before)
    const shrunk = resizeOverviewPlacement(before, 'services', 'left', 100_000, width)
    expect(shrunk.placements!.services).toEqual(placement(1, 10, 3))
    expectUnchangedPeers(before, shrunk, ['services'])
  })

  it('grows the final card into the row end without resizing its neighbour', () => {
    const before = fixture({ memories: placement(1, 1, 4), services: placement(1, 5, 4) }, { memories: .37 })
    const after = resizeOverviewPlacementKey(before, 'services', 'right', 'End', width)!
    expect(after.placements!.services).toEqual(placement(1, 5, 8))
    expectUnchangedPeers(before, after, ['services'])
    expect(overviewResizeRange(before, 'services', 'right', width)).toEqual({ min: 385, max: 1_060 })
  })

  it('reports anchor-specific min/max free widths and snaps small pointer changes to cells', () => {
    const before = fixture({ memories: placement(1, 1, 3), services: placement(1, 5, 4), corpus: placement(1, 11, 2) })
    const wide = 2_330
    const step = overviewGridUnit(wide)
    expect(overviewResizeRange(before, 'services', 'left', wide).max).toBeCloseTo(5 * step - 20)
    expect(overviewResizeRange(before, 'services', 'right', wide).max).toBeCloseTo(6 * step - 20)
    expect(resizeOverviewPlacement(before, 'services', 'right', .49 * step, wide)).toBe(before)
    expect(resizeOverviewPlacement(before, 'services', 'right', .51 * step, wide).placements!.services!.span).toBe(5)
  })

  it('uses Left/Right to move the actual grabbed edge, Home for minimum and End for maximum', () => {
    const before = fixture({ services: placement(1, 5, 4) })
    expect(resizeOverviewPlacementKey(before, 'services', 'left', 'ArrowLeft', width)!.placements!.services).toEqual(placement(1, 4, 5))
    expect(resizeOverviewPlacementKey(before, 'services', 'left', 'ArrowRight', width)!.placements!.services).toEqual(placement(1, 6, 3))
    expect(resizeOverviewPlacementKey(before, 'services', 'right', 'ArrowLeft', width)!.placements!.services).toEqual(placement(1, 5, 3))
    expect(resizeOverviewPlacementKey(before, 'services', 'right', 'ArrowRight', width)!.placements!.services).toEqual(placement(1, 5, 5))
    expect(resizeOverviewPlacementKey(before, 'services', 'left', 'Home', width)!.placements!.services).toEqual(placement(1, 6, 3))
    expect(resizeOverviewPlacementKey(before, 'services', 'left', 'End', width)!.placements!.services).toEqual(placement(1, 1, 8))
    expect(resizeOverviewPlacementKey(before, 'services', 'right', 'End', width)!.placements!.services).toEqual(placement(1, 5, 8))
    expect(resizeOverviewPlacementKey(before, 'services', 'right', 'Tab', width)).toBeNull()
  })

  it('refuses to reflow unmaterialized or viewport-incompatible input while resizing', () => {
    const raw = defaultOverviewLayout(['services'])
    expect(resizeOverviewPlacement(raw, 'services', 'right', unit, width)).toBe(raw)
    const narrow = fixture({ 'live-mcp': placement(1, 1, 6), corpus: placement(1, 7, 6) })
    expect(resizeOverviewPlacement(narrow, 'live-mcp', 'right', 100, 1_000)).toBe(narrow)
    expect(resizeOverviewPlacement(narrow, 'live-mcp', 'right', NaN, width)).toBe(narrow)
  })
})

describe('explicit grid moves', () => {
  it('moves into a free hole or new row without packing, resizing or moving other cards', () => {
    const before = fixture({ memories: placement(1, 1, 3), services: placement(1, 7, 3), corpus: placement(2, 1, 3) }, { memories: .37, services: .37 })
    const moved = moveOverviewPlacement(before, 'memories', 1, 4, width)
    expect(moved.placements!.memories).toEqual(placement(1, 4, 3))
    expectUnchangedPeers(before, moved, ['memories'])
    expect(moved.widths).toEqual(before.widths)
    const newRow = moveOverviewPlacement(moved, 'memories', 3, 10, width)
    expect(newRow.placements!.memories).toEqual(placement(3, 10, 3))
    expectUnchangedPeers(moved, newRow, ['memories'])
  })

  it('displaces only a collided card into the vacated slot, preserving every span and width', () => {
    const before = fixture({ memories: placement(1, 1, 4), services: placement(1, 5, 4), usage: placement(1, 9, 4), corpus: placement(2, 1, 4) }, { memories: .37, services: .31 })
    const after = moveOverviewPlacement(before, 'memories', 1, 5, width)
    expect(after.placements!.memories).toEqual(placement(1, 5, 4))
    expect(after.placements!.services).toEqual(placement(1, 1, 4))
    expectUnchangedPeers(before, after, ['memories', 'services'])
    expect(after.widths).toEqual(before.widths)
    expect(after.order).toEqual(['services', 'memories', 'usage', 'corpus'])
  })

  it('places multiple collided cards in vacated/first-free cells without touching a noncollided peer', () => {
    const before = fixture({ memories: placement(1, 1, 3), services: placement(1, 4, 3), graph: placement(1, 9, 4), 'fact-extraction': placement(2, 1, 6) })
    const after = moveOverviewPlacement(before, 'fact-extraction', 1, 1, width)
    expect(after.placements!['fact-extraction']).toEqual(placement(1, 1, 6))
    expect(after.placements!.memories).toEqual(placement(2, 1, 3))
    expect(after.placements!.services).toEqual(placement(2, 4, 3))
    expectUnchangedPeers(before, after, ['fact-extraction', 'memories', 'services'])
    for (const id of before.order) expect(after.placements![id]!.span).toBe(before.placements![id]!.span)
  })

  it('uses first-free space when a wider collided card cannot fit the vacated slot', () => {
    const before = fixture({ services: placement(1, 1, 6), memories: placement(2, 1, 3), usage: placement(2, 4, 3) })
    const after = moveOverviewPlacement(before, 'memories', 1, 1, width)
    expect(after.placements!.services).toEqual(placement(1, 4, 6))
    expect(after.placements!.usage).toEqual(before.placements!.usage)
    expect(after.placements!.services!.span).toBe(6)
    expect(validOverviewPlacements(after.placements, after.order)).toBe(true)
  })

  it('supports cell/row keyboard moves, Home and append-row End with unchanged spans', () => {
    const before = fixture({ memories: placement(1, 1, 3), services: placement(2, 4, 4) })
    expect(moveOverviewPlacementKey(before, 'services', 'Alt+ArrowLeft', width)!.placements!.services).toEqual(placement(2, 3, 4))
    expect(moveOverviewPlacementKey(before, 'services', 'ArrowUp', width)!.placements!.services).toEqual(placement(1, 4, 4))
    expect(moveOverviewPlacementKey(before, 'services', 'Home', width)!.placements!.services).toEqual(placement(1, 1, 4))
    const end = moveOverviewPlacementKey(before, 'memories', 'End', width)!
    expect(end.placements!.memories).toEqual(placement(3, 1, 3))
    expect(end.placements!.services).toEqual(before.placements!.services)
    expect(moveOverviewPlacementKey(before, 'memories', 'ArrowLeft', width)).toBe(before)
    expect(moveOverviewPlacementKey(before, 'memories', 'Tab', width)).toBeNull()
  })
})
