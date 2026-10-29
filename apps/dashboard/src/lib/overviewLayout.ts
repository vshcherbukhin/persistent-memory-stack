export const OVERVIEW_LAYOUT_VERSION = 2
export const OVERVIEW_LAYOUT_GAP = 20
const OVERVIEW_RESIZE_COLUMNS = 12

// Include gutters in the grid unit so equal halves/thirds always share a row.
const gridWidth = (available: number, span: number) =>
  Math.floor(((available + OVERVIEW_LAYOUT_GAP) * span / OVERVIEW_RESIZE_COLUMNS - OVERVIEW_LAYOUT_GAP) * 64) / 64

function resizeStops(id: OverviewCardId, available: number): number[] {
  const minimum = Math.min(OVERVIEW_CARD_SPECS[id].minWidth, available)
  return [...new Set([minimum, ...Array.from({ length: OVERVIEW_RESIZE_COLUMNS }, (_, index) => gridWidth(available, index + 1))
    .filter((width) => width >= minimum), available])].sort((a, b) => a - b)
}

function snapWidth(id: OverviewCardId, pixels: number, available: number): number {
  return resizeStops(id, available).reduce((closest, width) =>
    Math.abs(width - pixels) < Math.abs(closest - pixels) ? width : closest)
}

export const OVERVIEW_CARD_SPECS = {
  memories: { label: 'Saved Memories', columns: 3, minWidth: 340 },
  people: { label: 'Team & Users', columns: 3, minWidth: 340 },
  services: { label: 'Services', columns: 3, minWidth: 340 },
  sessions: { label: 'MCP sessions', columns: 3, minWidth: 340 },
  workers: { label: 'Workers', columns: 3, minWidth: 340 },
  usage: { label: 'Token usage', columns: 3, minWidth: 340 },
  graph: { label: 'Graph entities', columns: 3, minWidth: 340 },
  'fact-extraction': { label: 'Fact extraction', columns: 2, minWidth: 560 },
  embeddings: { label: 'Embeddings', columns: 2, minWidth: 560 },
  'live-mcp': { label: 'Live MCP activity', columns: 2, minWidth: 720 },
  corpus: { label: 'Corpus shape', columns: 2, minWidth: 360 },
} as const

export type OverviewCardId = keyof typeof OVERVIEW_CARD_SPECS
export interface OverviewPlacement { row: number; column: number; span: number }
export const OVERVIEW_MAX_GRID_ROWS = 256
export interface OverviewLayoutState {
  version: 2
  order: OverviewCardId[]
  /** Original v1 fractions of available row pixels, never reinterpreted as cell fractions. */
  widths: Partial<Record<OverviewCardId, number>>
  placements?: Partial<Record<OverviewCardId, OverviewPlacement>>
}
export interface LayoutStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

const knownId = (id: unknown): id is OverviewCardId => typeof id === 'string' && Object.hasOwn(OVERVIEW_CARD_SPECS, id)

export function overviewLayoutKey(identity: { userId: string; teamId: string | null }, version: 1 | 2 = 2): string {
  return `pm:overview-layout:v${version}:${encodeURIComponent(JSON.stringify([identity.userId, identity.teamId]))}`
}
export function overviewLegacyLayoutKey(identity: { userId: string; teamId: string | null }): string {
  return overviewLayoutKey(identity, 1)
}

export function defaultOverviewLayout(ids: OverviewCardId[]): OverviewLayoutState {
  return { version: OVERVIEW_LAYOUT_VERSION, order: [...ids], widths: {} }
}

/** Validate the full stored map before filtering cards that are not currently visible. */
export function validOverviewPlacements(value: unknown, ids?: OverviewCardId[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries: OverviewPlacement[] = []
  for (const [id, raw] of Object.entries(value)) {
    if (!knownId(id) || (ids && !ids.includes(id)) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some((key) => !['row', 'column', 'span'].includes(key)) ||
      !Number.isSafeInteger(item.row) || (item.row as number) < 1 || (item.row as number) > OVERVIEW_MAX_GRID_ROWS ||
      !Number.isSafeInteger(item.column) || (item.column as number) < 1 ||
      !Number.isSafeInteger(item.span) || (item.span as number) < 1 || (item.span as number) > 12 ||
      (item.column as number) + (item.span as number) > 13) return false
    const placement = item as unknown as OverviewPlacement
    if (entries.some((other) => other.row === placement.row && other.column < placement.column + placement.span && placement.column < other.column + other.span)) return false
    entries.push(placement)
  }
  return true
}

type DecodeResult = { layout: OverviewLayoutState; status: 'default' | 'saved' | 'invalid' | 'unsupported'; sourceVersion: 1 | 2 | null }
export function decodeOverviewLayout(raw: string | null, available: OverviewCardId[]): DecodeResult {
  const fallback = defaultOverviewLayout(available)
  if (raw === null) return { layout: fallback, status: 'default', sourceVersion: null }
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    const data = value as Record<string, unknown>
    if (data.version !== 1 && data.version !== 2) return { layout: fallback, status: 'unsupported', sourceVersion: null }
    const allowedKeys = data.version === 1 ? ['version', 'order', 'widths'] : ['version', 'order', 'widths', 'placements']
    if (Object.keys(data).some((key) => !allowedKeys.includes(key)) ||
      !Array.isArray(data.order) || data.order.length > Object.keys(OVERVIEW_CARD_SPECS).length ||
      !data.order.every(knownId) || new Set(data.order).size !== data.order.length ||
      !data.widths || typeof data.widths !== 'object' || Array.isArray(data.widths)) throw new Error('invalid')
    const widths: OverviewLayoutState['widths'] = {}
    for (const [id, width] of Object.entries(data.widths)) {
      if (!knownId(id) || typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 1) throw new Error('invalid')
      widths[id] = width
    }
    if (data.placements !== undefined && !validOverviewPlacements(data.placements, data.order)) throw new Error('invalid')
    const order = data.order.filter((id) => available.includes(id))
    const layout: OverviewLayoutState = { version: 2, order: [...order, ...available.filter((id) => !order.includes(id))], widths }
    if (data.placements !== undefined) {
      layout.placements = {}
      for (const [id, placement] of Object.entries(data.placements as Record<OverviewCardId, OverviewPlacement>)) {
        if (available.includes(id as OverviewCardId)) layout.placements[id as OverviewCardId] = { ...placement }
      }
    }
    return { layout, status: 'saved', sourceVersion: data.version }
  } catch {
    return { layout: fallback, status: 'invalid', sourceVersion: null }
  }
}

export function loadOverviewLayout(storage: LayoutStorage, key: string, available: OverviewCardId[], legacyKey?: string) {
  try {
    let raw = storage.getItem(key)
    const usedLegacy = raw === null && legacyKey !== undefined && legacyKey !== key
    if (usedLegacy) raw = storage.getItem(legacyKey!)
    return { ...decodeOverviewLayout(raw, available), storageAvailable: true, usedLegacy }
  } catch { return { layout: defaultOverviewLayout(available), status: 'default' as const, sourceVersion: null, storageAvailable: false, usedLegacy: false } }
}

/** Explicit completed actions save v2 only; reads never mutate or remove the v1 key. */
export function saveOverviewLayout(storage: LayoutStorage, key: string, layout: OverviewLayoutState): boolean {
  try {
    if (layout.version !== 2) return false
    const raw = JSON.stringify(layout)
    const decoded = decodeOverviewLayout(raw, layout.order)
    if (decoded.status !== 'saved' || decoded.sourceVersion !== 2) return false
    storage.setItem(key, raw)
    return true
  } catch { return false }
}

export function overviewCardWidth(id: OverviewCardId, available: number, layout: OverviewLayoutState): number {
  if (!Number.isFinite(available) || available <= 0) return 0
  const spec = OVERVIEW_CARD_SPECS[id]
  const saved = layout.widths[id]
  if (saved !== undefined) return snapWidth(id, available * saved, available)
  // Unsized lower panels remain an equal pair, using the larger content floor.
  const defaultMinimum = id === 'live-mcp' || id === 'corpus'
    ? Math.max(OVERVIEW_CARD_SPECS['live-mcp'].minWidth, OVERVIEW_CARD_SPECS.corpus.minWidth)
    : id === 'fact-extraction' || id === 'embeddings'
      ? Math.max(OVERVIEW_CARD_SPECS['fact-extraction'].minWidth, OVERVIEW_CARD_SPECS.embeddings.minWidth)
      : spec.minWidth
  const columns = Math.max(1, Math.min(spec.columns, Math.floor((available + OVERVIEW_LAYOUT_GAP) / (defaultMinimum + OVERVIEW_LAYOUT_GAP))))
  // CSS layout uses subpixels; round down so three fractional cards still fit.
  return Math.floor((available - OVERVIEW_LAYOUT_GAP * (columns - 1)) / columns * 64) / 64
}

export function resizeOverviewCard(layout: OverviewLayoutState, id: OverviewCardId, pixels: number, available: number): OverviewLayoutState {
  if (!Number.isFinite(available) || available <= 0 || !Number.isFinite(pixels)) return layout
  const snapped = snapWidth(id, pixels, available)
  return { ...layout, widths: { ...layout.widths, [id]: snapped / available } }
}

export function moveOverviewCard(layout: OverviewLayoutState, id: OverviewCardId, target: OverviewCardId, edge: 'before' | 'after'): OverviewLayoutState {
  if (id === target || !layout.order.includes(id) || !layout.order.includes(target)) return layout
  const order = layout.order.filter((current) => current !== id)
  order.splice(order.indexOf(target) + (edge === 'after' ? 1 : 0), 0, id)
  return { ...layout, order }
}

export function overviewMoveKey(layout: OverviewLayoutState, id: OverviewCardId, key: string): OverviewLayoutState | null {
  const index = layout.order.indexOf(id)
  if (index < 0) return null
  if (key === 'Home') return moveOverviewCard(layout, id, layout.order[0], 'before')
  if (key === 'End') return moveOverviewCard(layout, id, layout.order.at(-1)!, 'after')
  if (key === 'ArrowLeft' || key === 'ArrowUp') return index > 0 ? moveOverviewCard(layout, id, layout.order[index - 1], 'before') : layout
  if (key === 'ArrowRight' || key === 'ArrowDown') return index < layout.order.length - 1 ? moveOverviewCard(layout, id, layout.order[index + 1], 'after') : layout
  return null
}

export function overviewResizeKey(key: string, current: number, id: OverviewCardId, available: number): number | null {
  if (key === 'ArrowLeft') return resizeStops(id, available).findLast((width) => width < current - 1 / 64) ?? Math.min(OVERVIEW_CARD_SPECS[id].minWidth, available)
  if (key === 'ArrowRight') return resizeStops(id, available).find((width) => width > current + 1 / 64) ?? available
  if (key === 'Home') return Math.min(OVERVIEW_CARD_SPECS[id].minWidth, available)
  if (key === 'End') return available
  return null
}

export interface OverviewCardRect { id: OverviewCardId; left: number; top: number; right: number; bottom: number }
export function overviewDropTarget(rects: OverviewCardRect[], x: number, y: number): { id: OverviewCardId; edge: 'before' | 'after' } | null {
  if (!rects.length || !Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < Math.min(...rects.map((rect) => rect.left)) - 24 || x > Math.max(...rects.map((rect) => rect.right)) + 24 ||
    y < Math.min(...rects.map((rect) => rect.top)) - 24 || y > Math.max(...rects.map((rect) => rect.bottom)) + 24) return null
  const distance = (rect: OverviewCardRect) => Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom))
  const target = rects.reduce((closest, rect) => distance(rect) < distance(closest) ? rect : closest)
  return { id: target.id, edge: y < target.top || (y <= target.bottom && x < (target.left + target.right) / 2) ? 'before' : 'after' }
}

export function completeOverviewGesture(initial: OverviewLayoutState, preview: OverviewLayoutState, interaction: {
  kind: 'move' | 'resize'; id: OverviewCardId; moved: boolean; cancelled: boolean; target: ReturnType<typeof overviewDropTarget>
}): { layout: OverviewLayoutState; commit: boolean } {
  if (interaction.cancelled || !interaction.moved) return { layout: initial, commit: false }
  if (interaction.kind === 'resize') return { layout: preview, commit: true }
  if (!interaction.target || interaction.target.id === interaction.id) return { layout: initial, commit: false }
  return { layout: moveOverviewCard(initial, interaction.id, interaction.target.id, interaction.target.edge), commit: true }
}
