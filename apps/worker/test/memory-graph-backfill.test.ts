import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  buildMemoryGraphBackfillWhere,
  replayMemoryGraphBackfillRows,
  type MemoryGraphBackfillRow,
} from '../src/steps/memory-graph-backfill.ts'

const row = (id: string, graphStatus: 'pending' | 'failed' = 'pending'): MemoryGraphBackfillRow => ({
  id,
  teamId: 'team-1',
  project: 'general',
  content: `current content for ${id}`,
  graphVersion: new Date(`2026-07-03T00:0${id.length}:00.000Z`),
  graphStatus,
})

describe('buildMemoryGraphBackfillWhere', () => {
  it('targets only retryable memory graph rows', () => {
    expect(buildMemoryGraphBackfillWhere()).toEqual({
      graphStatus: { in: ['pending', 'failed'] },
    })
  })
})

describe('replayMemoryGraphBackfillRows', () => {
  it('posts current memory content for retryable rows without deleting historical episodes', async () => {
    const postEpisode = vi.fn(async () => 'episode-ok')

    const result = await replayMemoryGraphBackfillRows([row('m1'), row('m2', 'failed')], {
      postEpisode,
    })

    expect(result.stats).toEqual({ scanned: 2, synced: 2, failed: 0, deletedEpisodes: 0 })
    expect(result.syncedIds).toEqual(['m1', 'm2'])
    expect(result.synced).toEqual([
      { id: 'm1', groupId: 'team-1', episodeId: 'episode-ok' },
      { id: 'm2', groupId: 'team-1', episodeId: 'episode-ok' },
    ])
    expect(result.failed).toEqual([])
    expect(postEpisode).toHaveBeenNthCalledWith(1, {
      groupId: 'team-1',
      name: 'mem:m1',
      episodeBody: 'current content for m1',
      referenceTime: row('m1').graphVersion,
    })
  })

  it('continues after a row-level Graphiti failure and returns failed ids', async () => {
    const postEpisode = vi
      .fn()
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('graph down'))
      .mockResolvedValueOnce('ok')

    const result = await replayMemoryGraphBackfillRows([row('ok1'), row('bad'), row('ok2')], {
      postEpisode,
    })

    expect(result.stats).toEqual({ scanned: 3, synced: 2, failed: 1, deletedEpisodes: 0 })
    expect(result.syncedIds).toEqual(['ok1', 'ok2'])
    expect(result.failed).toEqual([{ id: 'bad', error: 'graph down' }])
  })

  it('queues removal instead of recording provenance when a posted episode loses its versioned row race', () => {
    const source = readFileSync(new URL('../src/steps/memory-graph-backfill.ts', import.meta.url), 'utf8')

    expect(source).toContain('const updated = await tx.memory.updateMany')
    expect(source).toContain('if (updated.count !== 1)')
    expect(source).toContain('tx.graphLifecycleOperation.createMany')
  })
})
