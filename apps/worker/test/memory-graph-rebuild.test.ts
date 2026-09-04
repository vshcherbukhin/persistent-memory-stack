import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import {
  buildMemoryGraphWhere,
  replayMemoryGraphRows,
  type MemoryGraphReplayRow,
} from '../src/steps/memory-graph-rebuild.ts'

const row = (id: string, teamId = 'team-1'): MemoryGraphReplayRow => ({
  id,
  teamId,
  project: 'general',
  content: `memory content for ${id}`,
  graphVersion: new Date(`2026-07-02T00:0${id.length}:00.000Z`),
})

describe('buildMemoryGraphWhere', () => {
  it('maps optional UI filters onto a Prisma MemoryWhereInput shape', () => {
    expect(
      buildMemoryGraphWhere({
        teamId: 'team-1',
        project: 'alpha',
        createdById: 'user-1',
      }),
    ).toEqual({ teamId: 'team-1', project: 'alpha', createdById: 'user-1' })
  })

  it('omits unset filters so superuser all-team rebuilds are possible', () => {
    expect(buildMemoryGraphWhere({})).toEqual({})
  })
})

describe('replayMemoryGraphRows', () => {
  it('posts the current memory content without deleting historical graph episodes', async () => {
    const postEpisode = vi.fn(async () => 'episode-ok')

    const stats = await replayMemoryGraphRows([row('m1'), row('m2', 'team-2')], {
      postEpisode,
    })

    expect(stats).toEqual({
      scanned: 2,
      rebuilt: 2,
      failed: 0,
      deletedEpisodes: 0,
      synced: [
        { id: 'm1', groupId: 'team-1', episodeId: 'episode-ok' },
        { id: 'm2', groupId: 'team-2', episodeId: 'episode-ok' },
      ],
    })
    expect(postEpisode).toHaveBeenNthCalledWith(1, {
      groupId: 'team-1',
      name: 'mem:m1',
      episodeBody: 'memory content for m1',
      referenceTime: row('m1').graphVersion,
    })
  })

  it('continues after a row-level Graphiti failure and counts it', async () => {
    const postEpisode = vi
      .fn()
      .mockResolvedValueOnce('episode-ok')
      .mockRejectedValueOnce(new Error('graph down'))
      .mockResolvedValueOnce('episode-ok')

    const stats = await replayMemoryGraphRows([row('ok1'), row('bad'), row('ok2')], {
      postEpisode,
    })

    expect(stats).toEqual({
      scanned: 3,
      rebuilt: 2,
      failed: 1,
      deletedEpisodes: 0,
      synced: [
        { id: 'ok1', groupId: 'team-1', episodeId: 'episode-ok' },
        { id: 'ok2', groupId: 'team-1', episodeId: 'episode-ok' },
      ],
    })
    expect(postEpisode).toHaveBeenCalledTimes(3)
  })

  it('queues removal instead of recording provenance when a rebuild post loses its versioned row race', () => {
    const source = readFileSync(new URL('../src/steps/memory-graph-rebuild.ts', import.meta.url), 'utf8')

    expect(source).toContain('const updated = await tx.memory.updateMany')
    expect(source).toContain('if (updated.count !== 1)')
    expect(source).toContain('tx.graphLifecycleOperation.createMany')
  })
})
