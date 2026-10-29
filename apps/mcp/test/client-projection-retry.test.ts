import {describe,it,expect,vi} from 'vitest'
import {projectAcceptedMemory,processPendingClientEmbeddings} from '../../../layers/mcp-runtime/src/projections.ts'
import type {MemoryApi,Runtime} from '../../../layers/mcp-runtime/src/runtime.ts'
const runtime=(embed=vi.fn().mockResolvedValue([[1,0]])):Runtime=>({mode:'client-bridge',deploymentMode:'local',pin:{modelId:'fixture',dim:2},mcpSessionIdleTimeoutSeconds:60,bridge:{embed}})
describe('client-managed projection adapter',()=>{
  it('projects the exact accepted revision and pinned vector without another knowledge write',async()=>{
    const post=vi.fn().mockResolvedValue({embeddingStatus:'embedded'})
    const result=await projectAcceptedMemory({post} as unknown as MemoryApi,runtime(),{id:'record',revision:3,content:'Accepted assertion text.'})
    expect(result).toBe(true)
    expect(post).toHaveBeenCalledExactlyOnceWith('/memories/record/embedding',{expectedRevision:3,contentHash:expect.stringMatching(/^[a-f0-9]{64}$/),modelId:'fixture',dim:2,vector:[1,0]})
  })
  it('retries a bounded pending batch after bridge failure without duplicating accepted records',async()=>{
    const embed=vi.fn().mockRejectedValueOnce(new Error('fixture unavailable')).mockResolvedValue([[1,0]])
    const get=vi.fn().mockResolvedValue({memories:[{id:'pending',revision:2,content:'Already accepted source assertion.'}]}),post=vi.fn().mockResolvedValue({})
    const api={get,post} as unknown as MemoryApi,rt=runtime(embed)
    expect(await processPendingClientEmbeddings(api,rt)).toBe(0);expect(post).not.toHaveBeenCalled()
    expect(await processPendingClientEmbeddings(api,rt)).toBe(1)
    expect(get).toHaveBeenCalledWith('/memories/pending-embeddings',{limit:10})
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('does no pending read or inference for server-managed topology',async()=>{
    const get=vi.fn(),embed=vi.fn(),rt={...runtime(embed),mode:'server' as const}
    expect(await processPendingClientEmbeddings({get} as unknown as MemoryApi,rt)).toBe(0)
    expect(get).not.toHaveBeenCalled();expect(embed).not.toHaveBeenCalled()
  })
})
