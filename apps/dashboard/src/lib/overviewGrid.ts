import {
  OVERVIEW_CARD_SPECS,
  OVERVIEW_LAYOUT_GAP,
  OVERVIEW_MAX_GRID_ROWS,
  overviewCardWidth,
  validOverviewPlacements,
  type OverviewCardId,
  type OverviewLayoutState,
  type OverviewPlacement,
} from './overviewLayout'

export const OVERVIEW_GRID_COLUMNS = 12
export type OverviewResizeEdge = 'left' | 'right'
type Placements = Partial<Record<OverviewCardId, OverviewPlacement>>

export function overviewGridUnit(available: number): number {
  return Number.isFinite(available) && available > 0 ? (available + OVERVIEW_LAYOUT_GAP) / OVERVIEW_GRID_COLUMNS : 0
}

export function overviewMinimumSpan(id: OverviewCardId, available: number): number {
  const unit = overviewGridUnit(available)
  return unit > 0 ? Math.min(12, Math.max(1, Math.ceil((OVERVIEW_CARD_SPECS[id].minWidth + OVERVIEW_LAYOUT_GAP) / unit))) : 12
}

export function overviewPlacementWidth(placement: OverviewPlacement, available: number): number {
  const unit = overviewGridUnit(available)
  return unit > 0 ? Math.max(0, placement.span * unit - OVERVIEW_LAYOUT_GAP) : 0
}

export function overviewGridRows(layout: OverviewLayoutState): number {
  return Math.max(0, ...layout.order.map((id) => layout.placements?.[id]?.row ?? 0))
}

const overlaps = (a: OverviewPlacement, b: OverviewPlacement) =>
  a.row === b.row && a.column < b.column + b.span && b.column < a.column + a.span
const bounded = (placement: OverviewPlacement) => Number.isSafeInteger(placement.row) && placement.row >= 1 && placement.row <= OVERVIEW_MAX_GRID_ROWS &&
  Number.isSafeInteger(placement.column) && placement.column >= 1 && Number.isSafeInteger(placement.span) && placement.span >= 1 && placement.column + placement.span <= 13
const free = (placement: OverviewPlacement, occupied: Placements) => bounded(placement) && !Object.values(occupied).some((other) => other && overlaps(placement, other))

function firstFree(span: number, occupied: Placements, startRow = 1, startColumn = 1): OverviewPlacement | null {
  for (let row = startRow; row <= OVERVIEW_MAX_GRID_ROWS; row++) {
    for (let column = row === startRow ? startColumn : 1; column <= 13 - span; column++) {
      const candidate = { row, column, span }
      if (free(candidate, occupied)) return candidate
    }
  }
  return null
}

function visualOrder(ids: OverviewCardId[], placements: Placements): OverviewCardId[] {
  return [...ids].sort((a, b) => placements[a]!.row - placements[b]!.row || placements[a]!.column - placements[b]!.column)
}

function initialSpan(layout: OverviewLayoutState, id: OverviewCardId, available: number): number {
  const minimum = overviewMinimumSpan(id, available)
  if (minimum === 12) return 12
  // A v1 .37 still targets 37% of row pixels, not 37% of the gutter-inclusive cells.
  const target = layout.widths[id] === undefined ? overviewCardWidth(id, available, layout) : available * layout.widths[id]!
  let closest = minimum
  for (let span = minimum + 1; span <= 12; span++) {
    if (Math.abs(overviewPlacementWidth({ row: 1, column: 1, span }, available) - target) <
      Math.abs(overviewPlacementWidth({ row: 1, column: 1, span: closest }, available) - target)) closest = span
  }
  return closest
}

/**
 * Materialize for one viewport without mutating the stored preference. Saved
 * cells/holes stay fixed unless a viewport floor requires a responsive projection.
 * That projection preserves visual order and uses compact additional rows; only
 * an explicit later action should persist it.
 */
export function resolveOverviewGrid(layout: OverviewLayoutState, available: number): OverviewLayoutState {
  const placements: Placements = {}
  const stored = layout.placements && validOverviewPlacements(layout.placements, layout.order) ? layout.placements : {}
  for (const id of layout.order) if (stored[id]) placements[id] = { ...stored[id]! }
  const storedIds = layout.order.filter((id) => placements[id])
  if (storedIds.some((id) => placements[id]!.span < overviewMinimumSpan(id, available))) {
    const order = [...visualOrder(storedIds, placements), ...layout.order.filter((id) => !placements[id])]
    const projected: Placements = {}
    let row = 1
    let column = 1
    for (const id of order) {
      const span = stored[id] ? Math.max(stored[id]!.span, overviewMinimumSpan(id, available)) : initialSpan(layout, id, available)
      const next = firstFree(span, projected, row, column)!
      projected[id] = next
      row = next.row
      column = next.column + next.span
    }
    return { ...layout, placements: projected, order }
  }
  const last = Object.values(placements).filter((placement): placement is OverviewPlacement => Boolean(placement))
    .sort((a, b) => b.row - a.row || (b.column + b.span) - (a.column + a.span))[0]
  let row = last?.row ?? 1
  let column = last ? last.column + last.span : 1
  for (const id of layout.order) {
    if (placements[id]) continue
    const span = initialSpan(layout, id, available)
    const placement = firstFree(span, placements, row, column) ?? firstFree(span, placements)!
    placements[id] = placement
    row = placement.row
    column = placement.column + placement.span
  }
  return { ...layout, placements, order: visualOrder(layout.order, placements) }
}

function materialized(layout: OverviewLayoutState): layout is OverviewLayoutState & { placements: Record<OverviewCardId, OverviewPlacement> } {
  return Boolean(layout.placements && validOverviewPlacements(layout.placements, layout.order) && layout.order.every((id) => layout.placements![id]))
}

function resizeBounds(layout: OverviewLayoutState, id: OverviewCardId, edge: OverviewResizeEdge, available: number) {
  if (!materialized(layout) || !layout.order.includes(id) || overviewGridUnit(available) <= 0) return null
  const placement = layout.placements[id]
  const minSpan = overviewMinimumSpan(id, available)
  if (placement.span < minSpan) return null // callers must resolve a viewport change before starting a gesture
  let left = 1
  let right = 13
  for (const otherId of layout.order) {
    if (otherId === id) continue
    const other = layout.placements[otherId]
    if (other.row !== placement.row) continue
    if (other.column + other.span <= placement.column) left = Math.max(left, other.column + other.span)
    if (other.column >= placement.column + placement.span) right = Math.min(right, other.column)
  }
  return { placement, minSpan, maxSpan: edge === 'left' ? placement.column + placement.span - left : right - placement.column, left, right }
}

export function overviewResizeRange(layout: OverviewLayoutState, id: OverviewCardId, edge: OverviewResizeEdge, available: number): { min: number; max: number } {
  const bounds = resizeBounds(layout, id, edge, available)
  return bounds ? {
    min: overviewPlacementWidth({ ...bounds.placement, span: bounds.minSpan }, available),
    max: overviewPlacementWidth({ ...bounds.placement, span: bounds.maxSpan }, available),
  } : { min: 0, max: 0 }
}

/** Only the grabbed edge moves. No resolver, packing, peer resize or row change. */
export function resizeOverviewPlacement(layout: OverviewLayoutState, id: OverviewCardId, edge: OverviewResizeEdge, deltaPixels: number, available: number): OverviewLayoutState {
  const bounds = resizeBounds(layout, id, edge, available)
  if (!bounds || !Number.isFinite(deltaPixels)) return layout
  const { placement, minSpan } = bounds
  const delta = Math.round(deltaPixels / overviewGridUnit(available))
  const end = placement.column + placement.span
  const next = edge === 'left'
    ? { ...placement, column: Math.max(bounds.left, Math.min(end - minSpan, placement.column + delta)) }
    : { ...placement, span: Math.max(minSpan, Math.min(bounds.right - placement.column, placement.span + delta)) }
  if (edge === 'left') next.span = end - next.column
  if (next.column === placement.column && next.span === placement.span) return layout
  return { ...layout, placements: { ...layout.placements, [id]: next },
    widths: { ...layout.widths, [id]: overviewPlacementWidth(next, available) / available } }
}

export function resizeOverviewPlacementKey(layout: OverviewLayoutState, id: OverviewCardId, edge: OverviewResizeEdge, key: string, available: number): OverviewLayoutState | null {
  const bounds = resizeBounds(layout, id, edge, available)
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return null
  if (!bounds) return layout
  const cells = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1
    : key === 'Home' ? (edge === 'left' ? 1 : -1) * (bounds.placement.span - bounds.minSpan)
      : (edge === 'left' ? -1 : 1) * (bounds.maxSpan - bounds.placement.span)
  return resizeOverviewPlacement(layout, id, edge, cells * overviewGridUnit(available), available)
}

/** Moving may displace collided cards; noncollided peers and every span stay fixed. */
export function moveOverviewPlacement(layout: OverviewLayoutState, id: OverviewCardId, row: number, column: number, available: number): OverviewLayoutState {
  if (!materialized(layout) || !layout.order.includes(id) || overviewGridUnit(available) <= 0 || !Number.isSafeInteger(row) || !Number.isSafeInteger(column)) return layout
  const previous = layout.placements[id]
  const target = { row: Math.max(1, Math.min(OVERVIEW_MAX_GRID_ROWS, row)), column: Math.max(1, Math.min(13 - previous.span, column)), span: previous.span }
  if (target.row === previous.row && target.column === previous.column) return layout
  const collided = visualOrder(layout.order.filter((other) => other !== id && overlaps(target, layout.placements[other])), layout.placements)
  const placements: Placements = { ...layout.placements }
  delete placements[id]
  for (const other of collided) delete placements[other]
  placements[id] = target
  for (const other of collided) {
    const span = layout.placements[other].span
    const vacated = { ...previous, span }
    placements[other] = free(vacated, placements) ? vacated : firstFree(span, placements)!
  }
  return { ...layout, placements, order: visualOrder(layout.order, placements) }
}

export function moveOverviewPlacementKey(layout: OverviewLayoutState, id: OverviewCardId, key: string, available: number): OverviewLayoutState | null {
  const normalized = key.replace(/^Alt\+/, '')
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(normalized)) return null
  if (!materialized(layout) || !layout.order.includes(id)) return layout
  const current = layout.placements[id]
  if (normalized === 'Home') return moveOverviewPlacement(layout, id, 1, 1, available)
  if (normalized === 'End') return overviewGridRows(layout) < OVERVIEW_MAX_GRID_ROWS
    ? moveOverviewPlacement(layout, id, overviewGridRows(layout) + 1, 1, available) : layout
  return moveOverviewPlacement(layout, id,
    current.row + (normalized === 'ArrowUp' ? -1 : normalized === 'ArrowDown' ? 1 : 0),
    current.column + (normalized === 'ArrowLeft' ? -1 : normalized === 'ArrowRight' ? 1 : 0), available)
}
