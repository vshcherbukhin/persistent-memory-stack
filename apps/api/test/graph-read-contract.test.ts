import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { graphiti, memoryFindMany, provenanceFindMany } = vi.hoisted(() => ({ graphiti: { search: vi.fn(), timeline: vi.fn(), contradictions: vi.fn() }, memoryFindMany: vi.fn(), provenanceFindMany: vi.fn() }))
vi.mock('../src/services/graphiti.ts', () => ({ graphiti }))
vi.mock('@pm/db', async original => ({ ...await original<typeof import('@pm/db')>(), runInTenant: async (fn: (tx: unknown) => unknown) => fn({ memory: { findMany: memoryFindMany }, graphEpisodeProvenance: {findMany:provenanceFindMany} }) }))
vi.mock('../src/services/graph-project-group.ts', () => ({ currentMemorySurface: () => 'personal', graphProjectGroup: (teamId: string, project: string) => `group:${teamId}:${project}` }))
import { GraphReadProjects, graphRoutes, tagKnownGraphFacts } from '../src/routes/graph.ts'

const identity = { userId: 'user-own', teamId: 'team-own', mountedTeamIds: ['team-mounted'], adminLevel: 'none' as const, isTeamMember: true, isTeamAdmin: false, isGlobalSuperuser: false }
const fact = (uuid: string, group_id: string) => ({ uuid, group_id, name: null, fact: null, source_node_uuid: null, target_node_uuid: null, source_name: null, target_name: null, valid_at: null, invalid_at: null, episodes: [`episode-${uuid}`] })
async function graphApp() {
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
  app.addHook('onRequest', (req, _reply, done) => { req.identity = identity; done() })
  app.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, _req, reply) => reply.code(error.statusCode ?? 500).send({ error: error.code ?? 'internal_error', message: error.message }))
  await app.register(graphRoutes); await app.ready(); return app
}

beforeEach(() => {
  graphiti.search.mockReset(); graphiti.timeline.mockReset(); graphiti.contradictions.mockReset()
  provenanceFindMany.mockReset().mockResolvedValue([])
  memoryFindMany.mockReset().mockImplementation(async (query: { distinct?: string[]; where?: {OR?:Array<{project?:{in:string[]}}> } }) => query.distinct ? ['alpha','beta','general'].filter(project=>!query.where?.OR||query.where.OR.some(filter=>filter.project?.in.includes(project))).map(project=>({project})) : ['own', 'own-old', 'own-new'].map(uuid => ({ id: `memory-${uuid}`, graphEpisodeId: `episode-${uuid}`, graphGroupId:'group:team-own:alpha', assertionStatus: 'proposal' })))
})
describe('graph evidence filters and revisions',()=>{
  it('keeps classification and time filters on all graph hydration, including zero matches',async()=>{
    const filters={topic:'scheduler',memoryType:'decision',assertionStatus:'proposal',createdAfter:'2020-01-01T00:00:00.000Z',createdBefore:'2030-01-01T00:00:00.000Z'}
    graphiti.search.mockResolvedValue({facts:[fact('own','group:team-own:alpha')]})
    const app=await graphApp()
    try {
      const response=await app.inject({method:'POST',url:'/graph/search',payload:{query:'scheduler',...filters}})
      expect(response.statusCode,response.body).toBe(200)
      for(const [query]of memoryFindMany.mock.calls){expect(query.where).toMatchObject({topicTags:{has:'scheduler'},memoryType:'decision',assertionStatus:'proposal',createdAt:{gte:new Date(filters.createdAfter),lte:new Date(filters.createdBefore)}})}
      memoryFindMany.mockResolvedValue([]);graphiti.search.mockClear()
      const zero=await app.inject({method:'POST',url:'/graph/search',payload:{query:'scheduler',...filters,topic:'zero-matches'}})
      expect(zero.json()).toEqual({facts:[]});expect(graphiti.search).not.toHaveBeenCalled()
    } finally {await app.close()}
  })
  it('retains current support beside a known older episode and rejects unknown support',async()=>{
    provenanceFindMany.mockResolvedValue([{subjectId:'memory-own',graphEpisodeId:'episode-prior',graphGroupId:'group:team-own:alpha'}])
    graphiti.search.mockResolvedValue({facts:[{...fact('own','group:team-own:alpha'),episodes:['episode-prior','episode-own']},{...fact('own','group:team-own:alpha'),uuid:'unknown-support',episodes:['episode-foreign','episode-own']}]})
    const app=await graphApp()
    try {
      const response=await app.inject({method:'POST',url:'/graph/search',payload:{query:'scheduler'}})
      expect(response.statusCode,response.body).toBe(200)
      expect(response.json().facts).toEqual([expect.objectContaining({uuid:'own',episodes:['episode-own'],sourceMemoryIds:['memory-own']})])
    } finally {await app.close()}
  })
  it('never reauthorizes invalid current dependency support through historical provenance',async()=>{
    const records=[{id:'memory-own',graphEpisodeId:'episode-own',graphGroupId:'group:team-own:alpha',assertionStatus:'observation',relationshipDependencies:[]},{id:'memory-invalid',graphEpisodeId:'episode-invalid',graphGroupId:'group:team-own:alpha',assertionStatus:'observation',relationshipDependencies:[{targetMemoryId:'target',targetRevision:1}]}]
    memoryFindMany.mockImplementation(async(query:{distinct?:string[];select?:{revision?:boolean}})=>query.distinct?[{project:'alpha'}]:query.select?.revision?[{id:'target',revision:2}]:records)
    provenanceFindMany.mockResolvedValue([{subjectId:'memory-invalid',graphEpisodeId:'episode-invalid',graphGroupId:'group:team-own:alpha'}])
    graphiti.search.mockResolvedValue({facts:[{...fact('mixed','group:team-own:alpha'),episodes:['episode-own','episode-invalid']}]})
    const app=await graphApp()
    try{const response=await app.inject({method:'POST',url:'/graph/search',payload:{query:'scheduler'}});expect(response.statusCode,response.body).toBe(200);expect(response.json().facts).toEqual([])}finally{await app.close()}
  })
})

describe('personal graph read contract', () => {
  it('defaults to the authorized personal corpus and keeps an explicit project filter strict', () => {
    expect(GraphReadProjects.safeParse(undefined).success).toBe(true)
    expect(GraphReadProjects.parse(['alpha', 'beta'])).toEqual(['alpha', 'beta'])
    expect(GraphReadProjects.safeParse([]).success).toBe(false)
    expect(GraphReadProjects.safeParse('').success).toBe(false)
  })
  it('labels only facts from exact server-derived graph partitions', () => {
    const labels = new Map([['group-own-alpha', { project: 'alpha', surface: 'personal' as const, relation: 'own' as const }], ['group-own-beta', { project: 'beta', surface: 'personal' as const, relation: 'own' as const }]])
    expect(tagKnownGraphFacts([{ uuid: 'own', group_id: 'group-own-alpha' }, { uuid: 'other-project', group_id: 'group-own-beta' }, { uuid: 'foreign', group_id: 'unexpected-group' }, { uuid: 'missing', group_id: null }] as never, labels)).toEqual([
      expect.objectContaining({ uuid: 'own', project: 'alpha', relation: 'own' }), expect.objectContaining({ uuid: 'other-project', project: 'beta', relation: 'own' }),
    ])
  })
  it('recalls across positive personal project partitions when no filter is supplied', async () => {
    graphiti.search.mockResolvedValue({ facts: [fact('own', 'group:team-own:alpha')] })
    const app = await graphApp()
    try {
      const result = await app.inject({ method: 'POST', url: '/graph/search', payload: { query: 'alpha' } })
      expect(result.statusCode, result.body).toBe(200)
      expect(graphiti.search).toHaveBeenCalledWith(expect.objectContaining({ groupIds: ['group:team-own:alpha', 'group:team-own:beta', 'group:team-own:general'] }))
      expect(memoryFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownershipState: 'personal', deletedAt: null, graphStatus: 'ok' }) }))
    } finally { await app.close() }
  })
  it('never adds mounted teams and drops unexpected groups even with a valid source episode', async () => {
    graphiti.search.mockResolvedValue({ facts: [fact('own', 'group:team-mounted:beta'), fact('own', 'group:unmounted:alpha'), fact('own', 'group:team-own:alpha')] })
    const app = await graphApp()
    try {
      const result = await app.inject({ method: 'POST', url: '/graph/search', payload: { query: 'alpha', projects: ['alpha', 'beta'], scope: 'own' } })
      expect(result.statusCode, result.body).toBe(200)
      expect(graphiti.search).toHaveBeenCalledWith(expect.objectContaining({ groupIds: ['group:team-own:alpha', 'group:team-own:beta'] }))
      expect(result.json().facts).toEqual([expect.objectContaining({ uuid: 'own', project: 'alpha', surface: 'personal', relation: 'own', sourceMemoryIds: ['memory-own'], assertionStatus: 'proposal', verification: 'derived_source_reported' })])
    } finally { await app.close() }
  })
  it('withholds missing/stale/deleted source episodes instead of reviving graph knowledge', async () => {
    graphiti.search.mockResolvedValue({ facts: [fact('missing-source', 'group:team-own:alpha'), { ...fact('own', 'group:team-own:alpha'), episodes: ['episode-own', 'episode-removed'] }, { ...fact('own', 'group:team-own:alpha'), episodes: [] }] })
    const app = await graphApp()
    try {
      const result = await app.inject({ method: 'POST', url: '/graph/search', payload: { query: 'alpha', projects: ['alpha'] } })
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json().facts).toEqual([])
    } finally { await app.close() }
  })
  it('tags timeline facts and drops entries outside the explicit partition', async () => {
    graphiti.timeline.mockResolvedValue({ entity_uuid: 'node-alpha', entries: [{ ...fact('own', 'group:team-mounted:alpha'), status: 'invalid' }, { ...fact('own', 'group:team-own:alpha'), status: 'valid' }] })
    const app = await graphApp()
    try {
      const result = await app.inject({ method: 'GET', url: '/graph/timeline?projects=alpha&includeInvalid=true' })
      expect(result.statusCode, result.body).toBe(200)
      expect(graphiti.timeline).toHaveBeenCalledWith(expect.objectContaining({ groupIds: ['group:team-own:alpha'], includeInvalid: true }))
      expect(result.json()).toMatchObject({ entityUuid: 'node-alpha', entries: [expect.objectContaining({ uuid: 'own', project: 'alpha', status: 'valid', assertionStatus: 'proposal' })] })
      expect(result.json().entries).toHaveLength(1)
    } finally { await app.close() }
  })
  it('keeps only fully authorized contradiction pairs and preserves both provenance sides', async () => {
    graphiti.contradictions.mockResolvedValue({ contradictions: [{ superseded: fact('own-old', 'group:team-own:alpha'), superseded_by: fact('own-new', 'group:team-own:alpha') }, { superseded: fact('own-old', 'group:team-own:alpha'), superseded_by: fact('unknown-new', 'group:team-own:alpha') }] })
    const app = await graphApp()
    try {
      const result = await app.inject({ method: 'GET', url: '/graph/contradictions?projects=alpha' })
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json().contradictions).toEqual([expect.objectContaining({ superseded: expect.objectContaining({ uuid: 'own-old', sourceMemoryIds: ['memory-own-old'] }), superseded_by: expect.objectContaining({ uuid: 'own-new', sourceMemoryIds: ['memory-own-new'] }) })])
    } finally { await app.close() }
  })
  it('rejects old mounted scopes and caller-supplied raw groups before graph access', async () => {
    const app = await graphApp()
    try {
      for (const payload of [{ query: 'alpha', projects: ['alpha'], scope: ['team-own', 'team-mounted'] }, { query: 'alpha', groupIds: ['foreign-group'] }]) {
        const result = await app.inject({ method: 'POST', url: '/graph/search', payload })
        expect(result.statusCode, result.body).toBe(400)
      }
      expect(graphiti.search).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
})
