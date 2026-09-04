import { afterEach, describe, expect, it, vi } from 'vitest'
import { postEpisode } from '../src/steps/graphiti.ts'

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 202, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('postEpisode', () => {
  it('does not send uuid on create because graphiti-core treats uuid as an existing-node lookup', async () => {
    const fetchMock = vi.fn(async () => okJson({ episode_uuid: 'episode-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      postEpisode('http://graphiti:8100', 1000, {
        groupId: 'team-1',
        name: 'doc:1',
        episodeBody: 'document body',
        referenceTime: new Date('2026-07-02T00:00:00Z'),
      }),
    ).resolves.toBe('episode-1')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      group_id: 'team-1',
      name: 'doc:1',
      episode_body: 'document body',
      source: 'text',
      reference_time: '2026-07-02T00:00:00.000Z',
    })
  })
})
