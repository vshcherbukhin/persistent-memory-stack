import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const route = readFileSync(
  fileURLToPath(new URL('../src/routes/memory-graph.ts', import.meta.url)),
  'utf8',
)
const app = readFileSync(fileURLToPath(new URL('../src/app.ts', import.meta.url)), 'utf8')

describe('Memory Graph dashboard read boundary', () => {
  it('registers bounded snapshot, facet, and activity endpoints', () => {
    expect(app).toContain('secured.register(memoryGraphRoutes)')
    expect(route).toContain("'/graph/snapshot'")
    expect(route).toContain("'/graph/facets'")
    expect(route).toContain("'/graph/activity'")
    expect(route).toContain('max(200)')
    expect(route).toContain('take: 5001')
    expect(route).toContain('take: req.query.limit + 1')
  })

  it('uses the shared validation-error serializer for malformed query values', () => {
    expect(route.match(/error: z\.literal\('validation_error'\)/g)).toHaveLength(2)
    expect(route.match(/issues: z\.unknown\(\)/g)).toHaveLength(2)
    expect(route).toContain('memoryLimit: z.coerce.number().int().min(20).max(200).default(100)')
  })

  it('derives tenancy via RLS and derives graph groups server-side', () => {
    expect(route.match(/runInTenant/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(route).toContain('graphProjectGroup(projectRow.teamId, projectRow.project)')
    expect(route).not.toMatch(/groupIds:\s*req\./)
    expect(route).not.toContain('group_ids')
  })

  it('keeps node payloads metadata-safe and cursor scope authenticated', () => {
    const select = route.slice(route.indexOf('const MEMORY_SELECT'), route.indexOf('function appendMemoryTopology'))
    expect(select).not.toContain('content')
    expect(route).toContain("createHmac('sha256', CURSOR_SECRET)")
    expect(route).toContain('timingSafeEqual')
    expect(route).toContain("error: 'invalid_graph_cursor'")
    expect(route).toContain('serverTime.getTime() - 60_000')
    expect(route).toContain('scopeHash(filters, identity.teamId!, identity.mountedTeamIds)')
  })

  it('uses record, creation, and access clocks for live graph activity', () => {
    expect(route).toContain('{ createdAt: { gt: since, lte: until } }')
    expect(route).toContain('{ recordUpdatedAt: { gt: since, lte: until } }')
    expect(route).toContain('{ lastAccessedAt: { gt: since, lte: until } }')
    expect(route).toContain("push('created', row.createdAt)")
    expect(route).toContain("push('updated', row.recordUpdatedAt)")
    expect(route).toContain("push('read', row.lastAccessedAt)")
    expect(route).toContain('lastActivityMemoryId: pageLastId')
  })

  it('uses signed keyset state instead of replaying offset fact pages', () => {
    expect(route).toContain('factAfterAt?: string | null')
    expect(route).toContain('afterAt: cursor?.factAfterAt ?? undefined')
    expect(route).toContain('nextFactAfterUuid = timeline.next_after_uuid')
    expect(route).not.toContain('factOffset')
  })
})
