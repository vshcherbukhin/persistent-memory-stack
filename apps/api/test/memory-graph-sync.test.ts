import { describe, expect, it, vi } from 'vitest'
import {
  graphSyncFailurePatch,
  graphSyncPendingPatch,
  graphSyncSuccessPatch,
  memoryGraphTelemetry,
  queueUnstampedGraphEpisodeCleanup,
} from '../src/services/memory-graph-sync.ts'

describe('memory graph sync status patches', () => {
  it('marks changed memory content as graph-pending before the best-effort episode write', () => {
    const graphVersion = new Date('2026-07-17T12:00:00.000Z')
    expect(graphSyncPendingPatch(graphVersion)).toEqual({
      graphStatus: 'pending',
      graphVersion,
      graphSyncedAt: null,
      graphError: null,
    })
  })

  it('stamps a successful episode write with its exact group and episode provenance', () => {
    const at = new Date('2026-07-03T12:00:00.000Z')
    expect(graphSyncSuccessPatch({ groupId: 'pmg2_partition', episodeId: 'episode-1' }, at)).toEqual({
      graphStatus: 'ok',
      graphSyncedAt: at,
      graphError: null,
      graphGroupId: 'pmg2_partition',
      graphEpisodeId: 'episode-1',
    })
  })

  it('keeps Graphiti failures retryable and stores a bounded diagnostic', () => {
    const patch = graphSyncFailurePatch(new Error('graph service unavailable'))

    expect(patch.graphStatus).toBe('failed')
    expect(patch.graphSyncedAt).toBeNull()
    expect(patch.graphError).toBe('graph service unavailable')
  })

  it('keeps an API write correlation id intact for exact Graphiti token attribution', () => {
    const telemetry = memoryGraphTelemetry({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: '22222222-2222-4222-8222-222222222222',
      project: 'project-a',
      graphGroupId: 'pmg2_partition',
      content: 'Benchmark content is not part of the telemetry shape.',
      graphVersion: new Date('2026-07-17T12:00:00.000Z'),
    }, '33333333-3333-4333-8333-333333333333')

    expect(telemetry).toMatchObject({
      operationId: '33333333-3333-4333-8333-333333333333',
      subjectKind: 'memory',
      subjectId: '11111111-1111-4111-8111-111111111111',
      project: 'project-a',
      stage: 'write',
    })
  })

  it('queues an exact lifecycle removal when an accepted episode cannot stamp its old row version', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 })
    await queueUnstampedGraphEpisodeCleanup(
      { graphLifecycleOperation: { createMany } } as never,
      {
        id: '11111111-1111-4111-8111-111111111111',
        teamId: '22222222-2222-4222-8222-222222222222',
        project: 'project-a',
        graphGroupId: 'pmg2_personal_project-a',
        content: 'The old content is intentionally not relevant to the cleanup row.',
        graphVersion: new Date('2026-07-17T12:00:00.000Z'),
      },
      { groupId: 'pmg2_personal_project-a', episodeId: '33333333-3333-4333-8333-333333333333' },
    )

    expect(createMany).toHaveBeenCalledWith({
      data: [{
        teamId: '22222222-2222-4222-8222-222222222222',
        project: 'project-a',
        subjectKind: 'memory',
        subjectId: '11111111-1111-4111-8111-111111111111',
        operation: 'remove',
        graphGroupId: 'pmg2_personal_project-a',
        graphEpisodeId: '33333333-3333-4333-8333-333333333333',
      }],
      skipDuplicates: true,
    })
  })
})
