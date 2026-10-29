import {describe,it,expect,vi} from 'vitest'
import {upsertVectors,pointIdForRow} from '../src/qdrant/upsert.ts'
import type {QdrantClient} from '@qdrant/js-client-rest'
describe('versioned memory vector lifecycle',()=>{
  it('removes only older same-owner points, including unversioned legacy points',async()=>{
    const upsert=vi.fn().mockResolvedValue({status:'completed'}),remove=vi.fn().mockResolvedValue({status:'completed'})
    const client={upsert,delete:remove} as unknown as QdrantClient
    const result=await upsertVectors(client,{teamId:'owner',pin:{modelId:'fixture',dim:2,vectorName:'fixture'},items:[{rowId:'memory',sourceKind:'memory',project:'general',revision:4,vector:[1,0]}]})
    expect(result.get('memory')).toBe(pointIdForRow('memory:r4'))
    expect(upsert.mock.calls[0]![1].points[0].payload.revision).toBe(4)
    expect(remove).toHaveBeenCalledExactlyOnceWith('memory_vectors',{wait:true,filter:{must:[{key:'team_id',match:{value:'owner'}},{key:'row_id',match:{value:'memory'}}],should:[{key:'revision',range:{lt:4}},{is_empty:{key:'revision'}}]}})
  })
  it('does not report a successful projection if stale-point cleanup failed',async()=>{
    const client={upsert:vi.fn().mockResolvedValue({status:'completed'}),delete:vi.fn().mockRejectedValue(new Error('fixture cleanup unavailable'))} as unknown as QdrantClient
    await expect(upsertVectors(client,{teamId:'owner',pin:{modelId:'fixture',dim:2,vectorName:'fixture'},items:[{rowId:'memory',sourceKind:'memory',project:'general',revision:2,vector:[1,0]}]})).rejects.toThrow('cleanup unavailable')
  })
})
