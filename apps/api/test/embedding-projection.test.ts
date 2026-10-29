import {createHash} from 'node:crypto'
import Fastify from 'fastify'
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod'
import {beforeEach,describe,expect,it,vi} from 'vitest'
const {memory,qdrant}=vi.hoisted(()=>({memory:{findUnique:vi.fn(),findMany:vi.fn(),updateMany:vi.fn()},qdrant:{upsert:vi.fn(),delete:vi.fn()}}))
vi.mock('@pm/db',async original=>({...await original<typeof import('@pm/db')>(),runInTenant:async(fn:(tx:unknown)=>unknown)=>fn({memory})}))
vi.mock('../src/services/embedding.ts',()=>({embeddingMode:'client-bridge',activePin:{modelId:'fixture',dim:2,vectorName:'fixture'},qdrant}))
import {embeddingProjectionRoutes} from '../src/routes/embedding-projections.ts'
const id='550e8400-e29b-41d4-a716-446655440000',content='Accepted classified assertion remains authoritative while its vector is pending.'
const payload={expectedRevision:2,contentHash:createHash('sha256').update(content).digest('hex'),modelId:'fixture',dim:2,vector:[1,0]}
async function fixture(){
  const app=Fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler)
  app.addHook('onRequest',(req,_reply,done)=>{req.identity={userId:id,teamId:id,isTeamMember:true,isTeamAdmin:false,isGlobalSuperuser:false,adminLevel:'none'};done()})
  app.setErrorHandler((error:{statusCode?:number;code?:string;message:string},_req,reply)=>reply.code(error.statusCode??500).send({error:error.code,message:error.message}))
  await app.register(embeddingProjectionRoutes);return app
}
beforeEach(()=>{
  vi.clearAllMocks();memory.findUnique.mockResolvedValue({id,teamId:id,project:'general',projectAssociations:[],revision:2,content});memory.updateMany.mockResolvedValue({count:1});memory.findMany.mockResolvedValue([])
  qdrant.upsert.mockResolvedValue({});qdrant.delete.mockResolvedValue({})
})
describe('derived embedding projection endpoint',()=>{
  it('stamps only the exact revision and never edits accepted assertion content',async()=>{
    const app=await fixture();try{
      const response=await app.inject({method:'POST',url:`/memories/${id}/embedding`,payload})
      expect(response.statusCode,response.body).toBe(200)
      expect(memory.updateMany).toHaveBeenCalledWith({where:{id,revision:2,deletedAt:null},data:{qdrantPointId:expect.any(String),embeddingModelId:'fixture',embeddingDim:2,embeddingStatus:'embedded'}})
    }finally{await app.close()}
  })
  it('rejects stale content/revision before vector IO',async()=>{
    const app=await fixture();try{
      const response=await app.inject({method:'POST',url:`/memories/${id}/embedding`,payload:{...payload,expectedRevision:1}})
      expect(response.statusCode).toBe(409);expect(qdrant.upsert).not.toHaveBeenCalled();expect(memory.updateMany).not.toHaveBeenCalled()
    }finally{await app.close()}
  })
  it('discards only its exact stale point if accepted revision changes during IO',async()=>{
    memory.updateMany.mockResolvedValue({count:0});memory.findUnique.mockResolvedValueOnce({id,teamId:id,project:'general',projectAssociations:[],revision:2,content}).mockResolvedValueOnce({revision:3})
    const app=await fixture();try{
      const response=await app.inject({method:'POST',url:`/memories/${id}/embedding`,payload})
      expect(response.statusCode).toBe(409)
      const point=qdrant.upsert.mock.calls[0]![1].points[0].id
      expect(qdrant.delete).toHaveBeenLastCalledWith('memory_vectors',{wait:true,points:[point]})
    }finally{await app.close()}
  })
  it('does not erase another producer projection for the same still-current revision',async()=>{
    memory.updateMany.mockResolvedValue({count:0});memory.findUnique.mockResolvedValueOnce({id,teamId:id,project:'general',projectAssociations:[],revision:2,content}).mockResolvedValueOnce({revision:2})
    const app=await fixture();try{
      expect((await app.inject({method:'POST',url:`/memories/${id}/embedding`,payload})).statusCode).toBe(409)
      expect(qdrant.delete).toHaveBeenCalledTimes(1) // older-revision filter only
      expect(qdrant.delete.mock.calls[0]![1]).toHaveProperty('filter')
    }finally{await app.close()}
  })
})
