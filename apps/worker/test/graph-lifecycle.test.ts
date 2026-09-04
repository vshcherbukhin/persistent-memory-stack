import { describe, expect, it, vi } from 'vitest'
import { replayGraphLifecycleOperations } from '../src/steps/graph-lifecycle.ts'

describe('graph lifecycle removal worker', () => {
  it('removes each pending provenance episode and verifies it is no longer present', async () => {
    const removeEpisode = vi.fn(async () => 1)
    const episodeImpact = vi.fn(async () => [{ episode_uuid: 'episode-1', exists: false }])

    const result = await replayGraphLifecycleOperations(
      [{ id: 'op-1', graphGroupId: 'pmg2_alpha', graphEpisodeId: 'episode-1' }],
      { removeEpisode, episodeImpact },
    )

    expect(result).toEqual({ completedIds: ['op-1'], failed: [] })
    expect(removeEpisode).toHaveBeenCalledWith('pmg2_alpha', 'episode-1')
    expect(episodeImpact).toHaveBeenCalledWith('pmg2_alpha', ['episode-1'])
  })

  it('keeps a failed command retryable when Graphiti still reports the episode', async () => {
    const result = await replayGraphLifecycleOperations(
      [{ id: 'op-1', graphGroupId: 'pmg2_alpha', graphEpisodeId: 'episode-1' }],
      {
        removeEpisode: async () => 1,
        episodeImpact: async () => [{ episode_uuid: 'episode-1', exists: true }],
      },
    )

    expect(result).toEqual({
      completedIds: [],
      failed: [{ id: 'op-1', error: 'Graphiti still reports the removed episode as present.' }],
    })
  })
})
