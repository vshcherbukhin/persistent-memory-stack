import { describe, expect, it } from 'vitest'
import {
  buildGraphDeletionPlan,
  assertProjectMovePreservesGraphBoundary,
} from '../src/services/graph-lifecycle.ts'

describe('graph lifecycle deletion planning', () => {
  it('keeps every historical episode when a memory is deleted', () => {
    expect(
      buildGraphDeletionPlan({
        current: { groupId: 'pmg2_alpha', episodeId: 'episode-current' },
        provenance: [
          { groupId: 'pmg2_alpha', episodeId: 'episode-first' },
          { groupId: 'pmg2_alpha', episodeId: 'episode-current' },
        ],
      }),
    ).toEqual([
      { groupId: 'pmg2_alpha', episodeId: 'episode-first' },
      { groupId: 'pmg2_alpha', episodeId: 'episode-current' },
    ])
  })

  it('rejects a project move once a memory has graph history', () => {
    expect(() =>
      assertProjectMovePreservesGraphBoundary({
        currentProject: 'alpha',
        nextProject: 'beta',
        hasGraphHistory: true,
      }),
    ).toThrow(/project history is immutable/i)
  })

  it('allows project classification before the first graph episode exists', () => {
    expect(() =>
      assertProjectMovePreservesGraphBoundary({
        currentProject: 'alpha',
        nextProject: 'beta',
        hasGraphHistory: false,
      }),
    ).not.toThrow()
  })
})
