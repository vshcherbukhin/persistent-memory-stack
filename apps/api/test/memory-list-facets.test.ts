import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dashboardRoute = readFileSync(fileURLToPath(new URL('../src/routes/dashboard/memories.ts', import.meta.url)), 'utf8')
const dataRoute = readFileSync(fileURLToPath(new URL('../src/routes/memories.ts', import.meta.url)), 'utf8')

describe('memory list facets and score filtering', () => {
  it('keeps dashboard list pages cursor-based while filtering persisted confidence scores', () => {
    expect(dashboardRoute).toContain('scoreMin: z.coerce.number().min(0).max(1).optional()')
    expect(dashboardRoute).toContain('scoreMax: z.coerce.number().min(0).max(1).optional()')
    expect(dashboardRoute).toContain("confidence: { gte: q.scoreMin, lte: q.scoreMax }")
    expect(dashboardRoute).toContain('nextCursor: z.string().nullable()')
  })

  it('returns dynamically discovered category badges with every dashboard page', () => {
    expect(dashboardRoute).toContain('badges: z.array(z.string())')
    expect(dashboardRoute).toContain('distinct: [\'category\']')
    expect(dashboardRoute).toContain('badges: badges.map((row) => row.category)')
  })

  it('uses the ordered record as its cursor rather than comparing unrelated UUIDs', () => {
    expect(dashboardRoute).toContain('cursor: { id: q.cursor }, skip: 1')
    expect(dataRoute).toContain('cursor: { id: q.cursor }, skip: 1')
    expect(dashboardRoute).not.toContain('...(q.cursor ? { id: { lt: q.cursor } } : {})')
    expect(dataRoute).not.toContain('...(q.cursor ? { id: { lt: q.cursor } } : {})')
  })

  it('keeps member data-plane pages and score filters aligned with the dashboard contract', () => {
    expect(dataRoute).toContain('scoreMin: z.coerce.number().min(0).max(1).optional()')
    expect(dataRoute).toContain('scoreMax: z.coerce.number().min(0).max(1).optional()')
    expect(dataRoute).toContain("confidence: { gte: q.scoreMin, lte: q.scoreMax }")
    expect(dataRoute).toContain('badges: z.array(z.string())')
  })

  it('applies category and confidence facets to exact and semantic searches', () => {
    expect(dashboardRoute).toContain('category: z.string().optional()')
    expect(dashboardRoute).toContain('scoreMin: z.coerce.number().min(0).max(1).optional()')
    expect(dashboardRoute).toContain('scoreMax: z.coerce.number().min(0).max(1).optional()')
    expect(dashboardRoute).toContain('...(body.category ? { category: body.category } : {})')
    expect(dashboardRoute).toContain('confidence: { gte: body.scoreMin, lte: body.scoreMax }')
    expect(dataRoute).toContain('category: z.string().optional()')
    expect(dataRoute).toContain('scoreMin: z.coerce.number().min(0).max(1).optional()')
    expect(dataRoute).toContain('scoreMax: z.coerce.number().min(0).max(1).optional()')
  })
})
