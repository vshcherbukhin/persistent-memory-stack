import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { findMany, graphiti } = vi.hoisted(() => ({
  findMany: vi.fn(),
  graphiti: { timeline: vi.fn() },
}))

vi.mock('@pm/db', () => ({
  Prisma: {},
  runInTenant: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ memory: { findMany } })),
}))
vi.mock('../src/services/graphiti.ts', () => ({ graphiti }))
vi.mock('../src/services/graph-project-group.ts', () => ({
  currentMemorySurface: () => 'personal',
  graphProjectGroup: (teamId: string, project: string) => `group:${teamId}:${project}`,
}))

import { memoryGraphRoutes } from '../src/routes/memory-graph.ts'

const identity = {
  userId: 'user-own',
  teamId: 'team-own',
  mountedTeamIds: [],
  adminLevel: 'none' as const,
  isTeamMember: true,
  isTeamAdmin: false,
  isGlobalSuperuser: false,
}

async function graphApp() {
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.addHook('onRequest', (req, _reply, done) => {
    req.identity = identity
    done()
  })
  await app.register(memoryGraphRoutes)
  await app.ready()
  return app
}

function row(id: string, changedAt: string) {
  return {
    id,
    teamId: 'team-own',
    project: 'alpha',
    category: 'decision',
    entities: ['Graphiti'],
    graphStatus: 'ready',
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
    recordUpdatedAt: new Date(changedAt),
    lastAccessedAt: null,
  }
}

function cursorPayload(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('Memory Graph activity and facet pagination', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T16:00:00.000Z'))
    findMany.mockReset()
    graphiti.timeline.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  it('keeps the same activity window until every bounded row page is consumed', async () => {
    const app = await graphApp()
    const handshake = await app.inject({ method: 'GET', url: '/graph/activity?limit=1' })
    expect(handshake.statusCode).toBe(200)

    vi.advanceTimersByTime(2_000)
    findMany
      .mockResolvedValueOnce([
        row('memory-a', '2026-08-31T16:00:01.000Z'),
        row('memory-b', '2026-08-31T16:00:01.500Z'),
      ])
      .mockResolvedValueOnce([row('memory-b', '2026-08-31T16:00:01.500Z')])

    const first = await app.inject({ method: 'GET', url: `/graph/activity?limit=1&cursor=${encodeURIComponent(handshake.json().nextCursor)}` })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ partial: true, events: [{ memoryId: 'memory-a', kind: 'updated' }] })
    const firstCursor = cursorPayload(first.json().nextCursor)
    expect(firstCursor).toMatchObject({
      since: '2026-08-31T16:00:00.000Z',
      until: '2026-08-31T16:00:02.000Z',
      lastActivityMemoryId: 'memory-a',
    })

    vi.advanceTimersByTime(1_000)
    const second = await app.inject({ method: 'GET', url: `/graph/activity?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}` })
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json()).toMatchObject({ partial: false, events: [{ memoryId: 'memory-b', kind: 'updated' }] })
    expect(cursorPayload(second.json().nextCursor)).toMatchObject({ since: '2026-08-31T16:00:02.000Z' })
    expect(findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: 'memory-a' })
    await app.close()
  })

  it('searches only the requested facet while retaining the other sections', async () => {
    findMany.mockResolvedValue([
      { project: 'alpha', category: 'decision', entities: ['Needle tag'], recordUpdatedAt: new Date('2026-08-31T15:00:00.000Z') },
      { project: 'beta', category: 'gotcha', entities: ['Other tag'], recordUpdatedAt: new Date('2026-08-31T14:00:00.000Z') },
    ])
    const app = await graphApp()
    const response = await app.inject({ method: 'GET', url: '/graph/facets?facet=tags&search=needle' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().projects.map((item: { value: string }) => item.value)).toEqual(['alpha', 'beta'])
    expect(response.json().badges.map((item: { value: string }) => item.value)).toEqual(['decision', 'gotcha'])
    expect(response.json().tags.map((item: { value: string }) => item.value)).toEqual(['Needle tag'])
    await app.close()
  })
})
