import {describe,it,expect,vi} from 'vitest'
const {count}=vi.hoisted(()=>({count:vi.fn()}))
vi.mock('@pm/db',async original=>({...await original<typeof import('@pm/db')>(),runInTenant:async(fn:(tx:unknown)=>unknown)=>fn({memory:{count}})}))
vi.mock('../src/tenant.ts',()=>({withSystemTenant:async(fn:()=>unknown)=>fn()}))
vi.mock('@pm/graph',()=>{throw new Error('Upgrade preservation must not load a graph provider')})
import {inspectCommunityGraphCompatibility} from '../src/steps/community-graph-compatibility.ts'
describe('Community graph upgrade preservation',()=>{
  it('reports owned legacy records and pending classified projections without model calls or purges',async()=>{
    count.mockResolvedValueOnce(5).mockResolvedValueOnce(3).mockResolvedValueOnce(2).mockResolvedValueOnce(1)
    expect(await inspectCommunityGraphCompatibility()).toEqual({state:'legacy_preserved',metrics:{personalMemories:5,legacyPreserved:3,classified:2,classifiedGraphPending:1,providerCalls:0,legacyGroupsPurged:0}})
    for(const [query]of count.mock.calls)expect(query.where).toMatchObject({ownershipState:'personal',deletedAt:null})
  })
})
