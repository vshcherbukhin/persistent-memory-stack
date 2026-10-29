/** Client-managed embeddings alter derived state only, never accepted knowledge. */
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { runInTenant, Prisma, type Tx } from '@pm/db'
import { assertActivePin, upsertVectors } from '@pm/shared'
import { activePin, embeddingMode, qdrant } from '../services/embedding.ts'
import { requireTeamMember } from '../authz/guards.ts'
import { KnowledgeError } from '../services/knowledge.ts'
const digest=(content:string)=>createHash('sha256').update(content).digest('hex')
export async function embeddingProjectionRoutes(app:FastifyInstance):Promise<void>{
  const routes=app.withTypeProvider<ZodTypeProvider>()
  routes.get('/memories/pending-embeddings',{preHandler:[requireTeamMember],schema:{querystring:z.object({limit:z.coerce.number().int().min(1).max(20).default(10)}).strict()}},async req=>{
    if(embeddingMode!=='client-bridge')return {memories:[]}
    const rows=await runInTenant((tx:Tx)=>tx.memory.findMany({where:{embeddingStatus:'pending',knowledge:{not:Prisma.DbNull}},take:req.query.limit,orderBy:[{createdAt:'asc'},{id:'asc'}],select:{id:true,revision:true,content:true}}))
    return {memories:rows.map(row=>({...row,contentHash:digest(row.content)}))}
  })
  routes.post('/memories/:id/embedding',{preHandler:[requireTeamMember],schema:{params:z.object({id:z.string().uuid()}),body:z.object({expectedRevision:z.number().int().positive(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),modelId:z.string(),dim:z.number().int().positive(),vector:z.array(z.number().finite()).min(1).max(100000)}).strict()}},async req=>{
    if(embeddingMode!=='client-bridge')throw new KnowledgeError('embedding_mode_conflict',409,'This projection adapter is for the configured client-managed topology only.')
    const body=req.body
    assertActivePin({modelId:body.modelId,dim:body.dim,vector:body.vector},activePin)
    const row=await runInTenant((tx:Tx)=>tx.memory.findUnique({where:{id:req.params.id}}))
    if(!row)throw new KnowledgeError('not_found',404,'No current authorized personal record has this ID.')
    if(row.revision!==body.expectedRevision||digest(row.content)!==body.contentHash)throw new KnowledgeError('revision_conflict',409,'Discard the stale projection; read the current accepted revision.')
    const points=await upsertVectors(qdrant,{teamId:row.teamId,pin:activePin,items:[{rowId:row.id,sourceKind:'memory',project:row.project,projectAssociations:row.projectAssociations,revision:row.revision,vector:body.vector}]})
    const pointId=points.get(row.id)!
    const stamped=await runInTenant((tx:Tx)=>tx.memory.updateMany({where:{id:row.id,revision:row.revision,deletedAt:null},data:{qdrantPointId:pointId,embeddingModelId:activePin.modelId,embeddingDim:activePin.dim,embeddingStatus:'embedded'}}))
    if(stamped.count!==1){
      const current=await runInTenant((tx:Tx)=>tx.memory.findUnique({where:{id:row.id},select:{revision:true}}))
      if(current?.revision!==row.revision)await qdrant.delete('memory_vectors',{wait:true,points:[pointId]})
      throw new KnowledgeError('revision_conflict',409,'The accepted revision changed while projecting; stale evidence was discarded.')
    }
    return {id:row.id,revision:row.revision,embeddingStatus:'embedded'}
  })
}
