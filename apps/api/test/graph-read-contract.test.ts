import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { graphiti } = vi.hoisted(() => ({ graphiti: {
  search: vi.fn(),
  timeline: vi.fn(),
  contradictions: vi.fn(),
} }))

vi.mock('../src/services/graphiti.ts', () => ({ graphiti }))
vi.mock('../src/services/graph-project-group.ts', () => ({
  currentMemorySurface: () => 'personal',
  graphProjectGroup: (teamId: string, project: string) => `group:${teamId}:${project}`,
}))

import { GraphReadProjects, tagKnownGraphFacts } from '../src/routes/graph.ts'
import { graphRoutes } from '../src/routes/graph.ts'

const identity = {
  userId: 'user-own',
  teamId: 'team-own',
  mountedTeamIds: ['team-mounted'],
  adminLevel: 'none' as const,
  isTeamMember: true,
  isTeamAdmin: false,
  isGlobalSuperuser: false,
}

const fact = (uuid: string, group_id: string) => ({
  uuid,
  group_id,
  name: null,
  fact: null,
  source_node_uuid: null,
  target_node_uuid: null,
  source_name: null,
  target_name: null,
  valid_at: null,
  invalid_at: null,
})

async function graphApp() {
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.addHook('onRequest', (req, _reply, done) => {
    req.identity = identity
    done()
  })
  app.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, _req, reply) =>
    reply.code(error.statusCode ?? 500).send({ error: error.code ?? 'internal_error', message: error.message }),
  )
  await app.register(graphRoutes)
  await app.ready()
  return app
}

describe('graph read contract', () => {
  it('requires a named project list at the direct API boundary', () => {
    expect(GraphReadProjects.safeParse(undefined).success).toBe(false)
    expect(GraphReadProjects.parse(['alpha', 'beta'])).toEqual(['alpha', 'beta'])
  })

  it('labels only facts from the requested graph partitions', () => {
    const labels = new Map([
      ['group-own-alpha', { project: 'alpha', surface: 'personal' as const, relation: 'own' as const }],
      ['group-mounted-alpha', { project: 'alpha', surface: 'personal' as const, relation: 'granted' as const }],
    ])
    const facts = tagKnownGraphFacts([
      { uuid: 'own', group_id: 'group-own-alpha' },
      { uuid: 'mounted', group_id: 'group-mounted-alpha' },
      { uuid: 'unknown', group_id: 'unexpected-group' },
      { uuid: 'missing', group_id: null },
    ] as never, labels)

    expect(facts).toEqual([
      expect.objectContaining({ uuid: 'own', project: 'alpha', surface: 'personal', relation: 'own' }),
      expect.objectContaining({ uuid: 'mounted', project: 'alpha', surface: 'personal', relation: 'granted' }),
    ])
  })

  beforeEach(() => {
    graphiti.search.mockReset()
    graphiti.timeline.mockReset()
    graphiti.contradictions.mockReset()
  })

  it('rejects a direct graph request without a named project list', async () => {
    const app = await graphApp()
    const result = await app.inject({ method: 'POST', url: '/graph/search', payload: { query: 'alpha' } })
    expect(result.statusCode).toBe(400)
    expect(graphiti.search).not.toHaveBeenCalled()
    await app.close()
  })

  it('sends only own/mounted requested partitions to Graphiti and drops an unexpected response group', async () => {
    graphiti.search.mockResolvedValue({
      facts: [
        fact('mounted', 'group:team-mounted:beta'),
        fact('unexpected', 'group:unmounted:alpha'),
        fact('own', 'group:team-own:alpha'),
      ],
    })
    const app = await graphApp()
    const result = await app.inject({
      method: 'POST',
      url: '/graph/search',
      payload: { query: 'alpha', projects: ['alpha', 'beta'], scope: ['team-own', 'team-mounted'] },
    })

    expect(result.statusCode, result.body).toBe(200)
    expect(graphiti.search).toHaveBeenCalledWith(expect.objectContaining({
      groupIds: [
        'group:team-own:alpha', 'group:team-own:beta',
        'group:team-mounted:alpha', 'group:team-mounted:beta',
      ],
    }))
    expect(result.json().facts).toEqual([
      expect.objectContaining({ uuid: 'own', project: 'alpha', surface: 'personal', relation: 'own' }),
      expect.objectContaining({ uuid: 'mounted', project: 'beta', surface: 'personal', relation: 'granted' }),
    ])
    await app.close()
  })

  it('tags timeline facts and drops entries outside the requested partition', async () => {
    graphiti.timeline.mockResolvedValue({
      entity_uuid: 'node-alpha',
      entries: [
        { ...fact('unexpected', 'group:team-unmounted:alpha'), status: 'invalid' },
        { ...fact('own', 'group:team-own:alpha'), status: 'valid' },
      ],
    })
    const app = await graphApp()
    const result = await app.inject({ method: 'GET', url: '/graph/timeline?projects=alpha&includeInvalid=true' })

    expect(result.statusCode, result.body).toBe(200)
    expect(graphiti.timeline).toHaveBeenCalledWith(expect.objectContaining({
      groupIds: ['group:team-own:alpha'], entityUuid: undefined, includeInvalid: true,
    }))
    expect(result.json()).toMatchObject({
      entityUuid: 'node-alpha',
      entries: [expect.objectContaining({ uuid: 'own', project: 'alpha', surface: 'personal', relation: 'own', status: 'valid' })],
    })
    expect(result.json().entries).toHaveLength(1)
    await app.close()
  })

  it('keeps only fully readable contradiction pairs and tags both provenance sides', async () => {
    graphiti.contradictions.mockResolvedValue({
      contradictions: [
        {
          superseded: fact('own-old', 'group:team-own:alpha'),
          superseded_by: fact('own-new', 'group:team-own:alpha'),
        },
        {
          superseded: fact('unknown-old', 'group:team-unmounted:alpha'),
          superseded_by: fact('unknown-new', 'group:team-unmounted:alpha'),
        },
      ],
    })
    const app = await graphApp()
    const result = await app.inject({ method: 'GET', url: '/graph/contradictions?projects=alpha' })

    expect(result.statusCode, result.body).toBe(200)
    expect(graphiti.contradictions).toHaveBeenCalledWith(expect.objectContaining({
      groupIds: ['group:team-own:alpha'], entityUuid: undefined,
    }))
    expect(result.json().contradictions).toEqual([
      expect.objectContaining({
        superseded: expect.objectContaining({ uuid: 'own-old', project: 'alpha', surface: 'personal', relation: 'own' }),
        superseded_by: expect.objectContaining({ uuid: 'own-new', project: 'alpha', surface: 'personal', relation: 'own' }),
      }),
    ])
    await app.close()
  })

  it('rejects an explicit graph scope outside the caller’s own or mounted teams', async () => {
    const app = await graphApp()
    const result = await app.inject({
      method: 'POST',
      url: '/graph/search',
      payload: { query: 'alpha', projects: ['alpha'], scope: ['team-unmounted'] },
    })
    expect(result.statusCode).toBe(403)
    expect(result.json()).toMatchObject({ error: 'scope_not_readable' })
    expect(graphiti.search).not.toHaveBeenCalled()
    await app.close()
  })
})
