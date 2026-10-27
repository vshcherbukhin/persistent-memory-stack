import Fastify from 'fastify'
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod'
import { tenantStore, type TenantCtx } from '@pm/db'
import { knowledgeArchiveRoutes } from '../src/routes/knowledge-archive.ts'
import { knowledgeRoutes } from '../src/routes/knowledge.ts'
export async function archiveFixture(ctx:TenantCtx){
  const app=Fastify()
  app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler)
  app.addHook('onRequest',(req,_reply,done)=>{req.identity=ctx;tenantStore.enterWith(ctx);done()})
  await app.register(knowledgeArchiveRoutes)
  await app.register(knowledgeRoutes)
  return app
}
