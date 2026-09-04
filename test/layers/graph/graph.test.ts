import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GraphitiClient,
  GraphitiError,
  graphSyncFailurePatch,
  graphSyncPendingPatch,
  graphSyncSuccessPatch,
  postEpisode,
} from '../../../layers/graph/src/index.ts'

describe('graph layer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('exposes Graphiti client and graph sync helpers from the layer path', () => {
    expect(new GraphitiClient('http://graphiti:8100', 1000)).toBeInstanceOf(GraphitiClient)
    expect(new GraphitiError(502, 'boom')).toMatchObject({
      code: 'graph_backend_error',
      status: 502,
      detail: 'boom',
    })
    expect(graphSyncPendingPatch()).toEqual({
      graphStatus: 'pending',
      graphSyncedAt: null,
      graphError: null,
    })
    expect(graphSyncSuccessPatch(new Date('2026-07-08T12:00:00.000Z'))).toMatchObject({
      graphStatus: 'ok',
      graphError: null,
    })
    expect(graphSyncFailurePatch(new Error('x'.repeat(1200))).graphError).toHaveLength(1000)
  })

  it('exposes worker Graphiti episode calls from the layer path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ episode_uuid: 'episode-1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await expect(postEpisode('http://graphiti:8100', 1000, {
      groupId: 'team-1',
      name: 'mem:1',
      episodeBody: 'hello',
      referenceTime: new Date('2026-07-08T12:00:00.000Z'),
    })).resolves.toBe('episode-1')

    expect(fetchMock).toHaveBeenCalledWith('http://graphiti:8100/episodes', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"group_id":"team-1"'),
    }))
  })
})
