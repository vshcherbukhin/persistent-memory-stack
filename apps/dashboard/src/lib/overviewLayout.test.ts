import { describe, expect, it, vi } from 'vitest'
import {
  OVERVIEW_MAX_GRID_ROWS, decodeOverviewLayout, defaultOverviewLayout, loadOverviewLayout,
  overviewLayoutKey, overviewLegacyLayoutKey, saveOverviewLayout, validOverviewPlacements,
  type OverviewCardId,
} from './overviewLayout'
import { resolveOverviewGrid } from './overviewGrid'

const ids: OverviewCardId[] = ['memories', 'services', 'fact-extraction', 'embeddings', 'live-mcp', 'corpus']
const identity = { userId: 'synthetic-owner', teamId: 'synthetic-personal' }
const key = overviewLayoutKey(identity)
const legacyKey = overviewLegacyLayoutKey(identity)
const defaults = () => defaultOverviewLayout(ids)
const v1 = () => ({ version: 1, order: ids, widths: { memories: .37 } })

function storage(initial: Record<string, string> = {}) {
  const records = new Map(Object.entries(initial))
  return { records, getItem: vi.fn((name: string) => records.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { records.set(name, value) }) }
}

describe('Overview version2 persistence codec', () => {
  it('scopes both storage generations by user and team without key collisions', () => {
    expect(key).toContain('pm:overview-layout:v2:')
    expect(legacyKey).toContain('pm:overview-layout:v1:')
    expect(key).not.toBe(legacyKey)
    expect(key).not.toBe(overviewLayoutKey({ ...identity, userId: 'other' }))
    expect(key).not.toBe(overviewLayoutKey({ ...identity, teamId: 'other' }))
    expect(overviewLayoutKey({ userId: 'a:b', teamId: 'c' })).not.toBe(overviewLayoutKey({ userId: 'a', teamId: 'b:c' }))
  })

  it('loads v1 into memory only, preserving the original .37 raw fraction and source bytes', () => {
    const raw = JSON.stringify(v1())
    const store = storage({ [legacyKey]: raw })
    const result = loadOverviewLayout(store, key, ids, legacyKey)
    expect(result.status).toBe('saved')
    expect(result.sourceVersion).toBe(1)
    expect(result.usedLegacy).toBe(true)
    expect(result.layout).toEqual({ ...v1(), version: 2 })
    expect(result.layout.widths.memories).toBe(.37)
    resolveOverviewGrid(result.layout, 1_600)
    expect(store.records.get(legacyKey)).toBe(raw)
    expect(store.records.has(key)).toBe(false)
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it('uses legacy fallback only when the v2 key is absent, never for corrupt or future v2 data', () => {
    for (const current of ['bad json', 'null', JSON.stringify({ version: 99 })]) {
      const store = storage({ [key]: current, [legacyKey]: JSON.stringify(v1()) })
      const loaded = loadOverviewLayout(store, key, ids, legacyKey)
      expect(loaded.status).toBe(current.includes('99') ? 'unsupported' : 'invalid')
      expect(store.getItem).toHaveBeenCalledTimes(1)
      expect(store.getItem).not.toHaveBeenCalledWith(legacyKey)
      expect(store.setItem).not.toHaveBeenCalled()
    }
    const store = storage({ [legacyKey]: JSON.stringify({ version: 42 }) })
    expect(loadOverviewLayout(store, key, ids, legacyKey).status).toBe('unsupported')
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it('does not look up an implicit global legacy key', () => {
    const store = storage({ [legacyKey]: JSON.stringify(v1()) })
    expect(loadOverviewLayout(store, key, ids).status).toBe('default')
    expect(store.getItem).toHaveBeenCalledTimes(1)
  })

  it('synchronously saves version2 and reloads placements without altering the preserved v1 value', () => {
    const legacy = JSON.stringify(v1())
    const store = storage({ [legacyKey]: legacy })
    const materialized = resolveOverviewGrid(loadOverviewLayout(store, key, ids, legacyKey).layout, 1_600)
    expect(saveOverviewLayout(store, key, materialized)).toBe(true)
    expect(store.records.has(key)).toBe(true)
    expect(JSON.parse(store.records.get(key)!)).toEqual(materialized)
    expect(store.records.get(legacyKey)).toBe(legacy)
    const loaded = loadOverviewLayout(store, key, ids, legacyKey)
    expect(loaded.sourceVersion).toBe(2)
    expect(loaded.usedLegacy).toBe(false)
    expect(loaded.layout).toEqual(materialized)
  })

  it('validates finite integral placements, bounds, allowed ids and unknown fields', () => {
    for (const item of [
      { row: 0, column: 1, span: 4 }, { row: OVERVIEW_MAX_GRID_ROWS + 1, column: 1, span: 4 },
      { row: 1.5, column: 1, span: 4 }, { row: 1, column: 0, span: 4 },
      { row: 1, column: 1, span: 0 }, { row: 1, column: 12, span: 2 },
      { row: 1, column: Infinity, span: 4 }, { row: 1, column: 1, span: 4.5 },
      { row: 1, column: 1, span: 4, extra: true },
    ]) {
      expect(validOverviewPlacements({ memories: item }, ids)).toBe(false)
      expect(decodeOverviewLayout(JSON.stringify({ ...defaults(), placements: { memories: item } }), ids).status).toBe('invalid')
    }
    expect(validOverviewPlacements({ unknown: { row: 1, column: 1, span: 4 } })).toBe(false)
    expect(validOverviewPlacements({ memories: { row: 1, column: 1, span: 4 } }, ['corpus'])).toBe(false)
  })

  it('rejects overlap before filtering hidden cards, while adjacency and distinct rows are valid', () => {
    const overlap = { memories: { row: 1, column: 1, span: 4 }, services: { row: 1, column: 4, span: 4 } }
    expect(validOverviewPlacements(overlap)).toBe(false)
    expect(decodeOverviewLayout(JSON.stringify({ ...defaults(), placements: overlap }), ['memories']).status).toBe('invalid')
    const adjacent = { memories: { row: 1, column: 1, span: 4 }, services: { row: 1, column: 5, span: 4 }, corpus: { row: 2, column: 1, span: 4 } }
    expect(validOverviewPlacements(adjacent)).toBe(true)
    expect(decodeOverviewLayout(JSON.stringify({ ...defaults(), placements: adjacent }), ids).status).toBe('saved')
  })

  it('filters unavailable cards and appends newly available cards without inventing stored positions', () => {
    const raw = JSON.stringify({ version: 2, order: ['corpus', 'people', 'memories'], widths: { corpus: .75 },
      placements: { corpus: { row: 1, column: 7, span: 6 }, people: { row: 1, column: 1, span: 6 } } })
    const decoded = decodeOverviewLayout(raw, ids)
    expect(decoded.layout.order.slice(0, 2)).toEqual(['corpus', 'memories'])
    expect(decoded.layout.order).not.toContain('people')
    expect(decoded.layout.order).toHaveLength(ids.length)
    expect(decoded.layout.placements).toEqual({ corpus: { row: 1, column: 7, span: 6 } })
    expect(decoded.layout.widths.corpus).toBe(.75)
  })

  it('rejects malformed orders, widths, mixed version formats, and saves of invalid state', () => {
    for (const candidate of [
      { ...defaults(), order: ['memories', 'memories'] }, { ...defaults(), order: ['unknown'] },
      { ...defaults(), widths: { corpus: 0 } }, { ...defaults(), widths: { corpus: 1.1 } },
      { ...defaults(), widths: { unknown: .5 } }, { ...defaults(), placements: [] },
      { ...v1(), placements: {} }, { ...defaults(), unknown: true },
    ]) expect(decodeOverviewLayout(JSON.stringify(candidate), ids).status).toBe('invalid')
    const store = storage()
    expect(saveOverviewLayout(store, key, { ...defaults(), widths: { corpus: Infinity } })).toBe(false)
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it('reports blocked reads/writes and persists explicit reset without deleting old data', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    expect(loadOverviewLayout(blocked, key, ids, legacyKey).storageAvailable).toBe(false)
    expect(saveOverviewLayout(blocked, key, defaults())).toBe(false)
    const store = storage({ [legacyKey]: JSON.stringify(v1()) })
    expect(saveOverviewLayout(store, key, defaults())).toBe(true)
    expect(JSON.parse(store.records.get(key)!)).toEqual(defaults())
    expect(store.records.has(legacyKey)).toBe(true)
  })
})
