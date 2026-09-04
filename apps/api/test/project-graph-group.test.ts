import { describe, expect, it } from 'vitest'
import { deriveProjectGraphGroup } from '@pm/graph'

describe('deriveProjectGraphGroup', () => {
  const base = { secret: 'test-secret', teamId: 'team-a', project: 'persistent-memory', surface: 'personal' as const }

  it('is deterministic and does not expose the team or project in the Graphiti namespace', () => {
    const group = deriveProjectGraphGroup(base)
    expect(group).toBe(deriveProjectGraphGroup(base))
    expect(group).toMatch(/^pmg2_[A-Za-z0-9_-]+$/)
    expect(group).not.toContain(base.teamId)
    expect(group).not.toContain(base.project)
  })

  it('changes partition for each team, project, or memory surface', () => {
    const group = deriveProjectGraphGroup(base)
    expect(deriveProjectGraphGroup({ ...base, teamId: 'team-b' })).not.toBe(group)
    expect(deriveProjectGraphGroup({ ...base, project: 'customer-portal' })).not.toBe(group)
    expect(deriveProjectGraphGroup({ ...base, surface: 'shared' })).not.toBe(group)
  })
})
