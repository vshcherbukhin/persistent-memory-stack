import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('Memory List trust and filter controls', () => {
  it('removes the manual verification affordance and uses the tab for the list count', () => {
    const client = source('../app/(dashboard)/memories/MemoriesClient.tsx')

    expect(client).not.toContain('verifyMemoryAction')
    expect(client).not.toContain('m.verified')
    expect(client).toContain('Memory List ({total.toLocaleString()})')
  })

  it('uses one applied confidence-range popover instead of two score text fields', () => {
    const client = source('../app/(dashboard)/memories/MemoriesClient.tsx')

    expect(client).toContain('<ConfidenceRangeSelect')
    expect(client).not.toContain('placeholder="Min score"')
    expect(client).not.toContain('placeholder="Max score"')
  })

  it('keeps desktop filters compact so search owns the remaining row width', () => {
    const client = source('../app/(dashboard)/memories/MemoriesClient.tsx')
    const css = source('../app/globals.css')

    expect(client).toContain('className="memory-project-filter"')
    expect(client).toContain('className="memory-badge-filter"')
    expect(css).toContain('.memory-filter-row {')
    expect(css).toContain('flex-wrap: nowrap;')
    expect(css).toContain('.memory-filter-row > .confidence-range-select')
    expect(css).toContain('flex: 0 0 194px;')
    expect(css).toContain('@media (max-width: 960px)')
  })

  it('sizes the actions track for edit and delete rather than the retired verify action', () => {
    const client = source('../app/(dashboard)/memories/MemoriesClient.tsx')

    expect(client).toContain('const actionsWidth = Math.max(84,')
    expect(client).toContain('return Math.max(84, 28 + count * 26 + Math.max(0, count - 1) * 8)')
  })

  it('keeps active badge and confidence filters when a text search is active', () => {
    const client = source('../app/(dashboard)/memories/MemoriesClient.tsx')
    const actions = source('../app/(dashboard)/memories/actions.ts')

    expect(client).toContain('searchMemoriesAction(query, teamId, project, filterBadge || undefined, parsedScore(scoreMin), parsedScore(scoreMax), surface)')
    expect(actions).toContain('category, scoreMin, scoreMax')
  })

  it('keeps the dynamically discovered badge list while text search returns no facets', () => {
    const client = source('../app/(dashboard)/memories/MemoriesClient.tsx')

    expect(client).toContain('if (res.badges.length > 0) setBadges(res.badges)')
  })
})
