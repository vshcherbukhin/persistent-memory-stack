import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveMemoryGraphRebuildRequest } from '../src/services/memory-graph-rebuild.ts'

const adminMemoriesRoute = readFileSync(
  fileURLToPath(new URL('../src/routes/dashboard/memories.ts', import.meta.url)),
  'utf8',
)

const identity = (overrides: Partial<any> = {}) => ({
  userId: 'user-current',
  teamId: 'team-own',
  adminLevel: 'admin',
  isTeamAdmin: true,
  isGlobalSuperuser: false,
  ...overrides,
})

describe('resolveMemoryGraphRebuildRequest', () => {
  it('forces a team admin rebuild onto their own team even when no team is selected', () => {
    expect(resolveMemoryGraphRebuildRequest(identity(), { project: 'alpha' })).toEqual({
      filters: { teamId: 'team-own', project: 'alpha' },
    })
  })

  it('rejects a team admin attempting to rebuild another team graph', () => {
    expect(() =>
      resolveMemoryGraphRebuildRequest(identity(), { teamId: 'team-other' }),
    ).toThrow(/own team/)
  })

  it('allows a superuser to rebuild all teams or narrow by team/project/author', () => {
    const superuser = identity({ adminLevel: 'superuser', isGlobalSuperuser: true, teamId: null })
    expect(resolveMemoryGraphRebuildRequest(superuser, {})).toEqual({ filters: {} })
    expect(
      resolveMemoryGraphRebuildRequest(superuser, {
        teamId: 'team-2',
        project: 'beta',
        createdById: 'author-1',
      }),
    ).toEqual({
      filters: { teamId: 'team-2', project: 'beta', createdById: 'author-1' },
    })
  })
})

describe('dashboard memory routes keep Graphiti in the normal mutation path', () => {
  it('marks changed/imported rows graph-pending and delegates episode stamping to the sync helper', () => {
    expect(adminMemoriesRoute.match(/graphSyncPendingPatch/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(adminMemoriesRoute.match(/postMemoryGraphEpisodeAndStamp/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(adminMemoriesRoute).toContain('graphVersion: graphVersion.graphVersion')
  })

  it('uses a single-use live-impact preview and durable lifecycle commands for dashboard deletes', () => {
    expect(adminMemoriesRoute).toContain("'/memories/:id/delete-preview'")
    expect(adminMemoriesRoute).toContain('graph_delete_preview_required')
    expect(adminMemoriesRoute).toContain('enqueueGraphRemoval')
  })

  it('keeps bulk deletion behind a scoped, single-use graph-impact preview', () => {
    const dataMemoriesRoute = readFileSync(
      fileURLToPath(new URL('../src/routes/memories.ts', import.meta.url)),
      'utf8',
    )

    expect(dataMemoriesRoute).toContain("'/memories/bulk-delete-preview'")
    expect(dataMemoriesRoute).toContain("'/memories/bulk'")
    expect(dataMemoriesRoute).toContain('bulk_graph_delete_preview_required')
    expect(dataMemoriesRoute).toContain('createdById: id.userId')
    expect(dataMemoriesRoute).toContain('previewToken: z.string().uuid()')
    expect(dataMemoriesRoute).toContain('graphDeletePreview.updateMany')
    expect(dataMemoriesRoute).toContain('consumedAt: null')
  })

  it('uses the graph-only row version when conditionally stamping an inline graph episode', () => {
    const dataMemoriesRoute = readFileSync(
      fileURLToPath(new URL('../src/routes/memories.ts', import.meta.url)),
      'utf8',
    )
    expect(dataMemoriesRoute).toContain('Vector bookkeeping advances updatedAt but deliberately leaves the graph')
    expect(dataMemoriesRoute.match(/select: \{ graphVersion: true \}/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(adminMemoriesRoute.match(/select: \{ graphVersion: true \}/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})
