import { afterEach, describe, expect, it, vi } from 'vitest'
import { GraphitiClient } from '../src/clients/graphiti.ts'

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 202, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('GraphitiClient.postEpisode', () => {
  it('does not send uuid on create because graphiti-core treats uuid as an existing-node lookup', async () => {
    const fetchMock = vi.fn(async () => okJson({ episode_uuid: 'episode-1' }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new GraphitiClient('http://graphiti:8100', 1000)
    await expect(
      client.postEpisode({
        groupId: 'team-1',
        name: 'mem:1',
        episodeBody: 'remember this',
        referenceTime: new Date('2026-07-02T00:00:00Z'),
      }),
    ).resolves.toBe('episode-1')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      group_id: 'team-1',
      name: 'mem:1',
      episode_body: 'remember this',
      source: 'text',
      reference_time: '2026-07-02T00:00:00.000Z',
    })
  })
})

describe('GraphitiClient.removeEpisode', () => {
  it('uses the durable Graphiti episode UUID for provenance-aware removal', async () => {
    const fetchMock = vi.fn(async () => okJson({ deleted: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new GraphitiClient('http://graphiti:8100', 1000)
    await expect(client.removeEpisode({ groupId: 'project-group-1', episodeId: 'episode-1' })).resolves.toBe(1)

    expect(fetchMock.mock.calls[0]![0]).toBe('http://graphiti:8100/episodes')
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body as string)).toEqual({
      group_id: 'project-group-1',
      episode_uuid: 'episode-1',
    })
  })
})

describe('GraphitiClient.episodeImpact', () => {
  it('requests bounded episode provenance from one derived group', async () => {
    const fetchMock = vi.fn(async () => okJson({ impacts: [{ episode_uuid: 'episode-1', exists: true, primary_fact_count: 1, supporting_fact_count: 0, primary_facts: [] }] }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new GraphitiClient('http://graphiti:8100', 1000)
    await expect(client.episodeImpact({ groupId: 'project-group-1', episodeIds: ['episode-1'] })).resolves.toHaveLength(1)

    expect(fetchMock.mock.calls[0]![0]).toBe('http://graphiti:8100/episodes/impact')
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ group_id: 'project-group-1', episode_uuids: ['episode-1'] })
  })
})

describe('GraphitiClient.deleteEpisode', () => {
  it('keeps the temporary name-based contract available while pre-v2 writers have no episode UUID', async () => {
    const fetchMock = vi.fn(async () => okJson({ deleted: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new GraphitiClient('http://graphiti:8100', 1000)
    await expect(client.deleteEpisode({ groupId: 'legacy-team-1', name: 'mem:1' })).resolves.toBe(1)

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ group_id: 'legacy-team-1', name: 'mem:1' })
  })
})
