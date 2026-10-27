/** Bounded historical archive conversion. This is not an ordinary write adapter. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { KnowledgeClassification, KnowledgeWrite } from '@pm/shared'
import { getCtx, runInTenant, ownerPrisma, Prisma, type Tx } from '@pm/db'
import { PiiDetectedError } from '../authz/errors.ts'
import { config } from '../config.ts'
import { assertNoPii } from '../protocol/validation.ts'
import { archivePrivacyView } from '../protocol/knowledge-privacy.ts'
import { KnowledgeError, knowledgeRequestHash, knowledgeWhere, classificationData, resolveClassification, persistClaim } from '../services/knowledge.ts'

const LegacyShape = z.enum(['gotcha_fix','user_correction','tool_gap','prd','atomic'])
const ArchiveRow = z.object({
  id:z.string().uuid(),content:z.string().min(1).max(64000),project:z.string().min(1),category:z.string(),shape:LegacyShape,entities:z.array(z.string()),
  createdAt:z.string().datetime(),recordUpdatedAt:z.string().datetime(),createdById:z.string().uuid().nullable().optional(),teamId:z.string().uuid().optional(),
  sessionId:z.string().nullable().optional(),metadata:z.unknown().optional(),revision:z.number().int().positive().optional(),
  classification:KnowledgeClassification.nullable().optional(),revisionHistory:z.array(z.object({revision:z.number().int().positive(),snapshot:z.unknown(),intent:z.string(),reason:z.string(),evidence:z.unknown(),actorId:z.string().uuid().nullable().optional(),createdAt:z.string().datetime()}).passthrough()).max(10000).optional(),
  sourceProvenance:z.enum(['human_verified','api_return','agent_inferred']).optional(),memoryTier:z.enum(['semantic','episodic','procedural','working']).optional(),confidence:z.number().min(0).max(1).optional(),
  archiveSignature:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  catalog:z.array(z.object({kind:z.enum(['topic','project','system']),name:z.string().min(1).max(120),aliases:z.array(z.string().min(1).max(120)).max(100),reason:z.string().min(1).max(2000)}).strict()).max(100).optional(),
  relationshipDependencies:z.unknown().optional(),
}).passthrough()
const Body=z.object({schema:z.enum(['pm.memory-export/1','pm.memory-export/2']),ownerConfirmation:z.literal(true),memories:z.array(ArchiveRow).min(1).max(5000),notify:z.boolean().optional()}).strict()
function json(value:unknown):Prisma.InputJsonValue{return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue}

function archiveSignature(record: Record<string,unknown>): string {
  const key=config.TOKEN_PEPPER || config.GRAPH_GROUP_SECRET
  if(!key)throw new KnowledgeError('archive_signing_unavailable',503,'The preserved local signing configuration is required for authenticated revision archives.')
  const {archiveSignature:_signature,...payload}=record
  return createHmac('sha256',key).update(`pm.memory-export/2\0${getCtx().teamId}\0${getCtx().userId}\0${knowledgeRequestHash(payload)}`).digest('hex')
}
function verifyArchiveRecord(record: Record<string,unknown>): boolean {
  if(typeof record.archiveSignature!=='string')return false
  const actual=Buffer.from(record.archiveSignature,'hex'),expected=Buffer.from(archiveSignature(record),'hex')
  return actual.length===expected.length&&timingSafeEqual(actual,expected)
}
function legacyWitnessMatches(snapshot:unknown, record:z.infer<typeof ArchiveRow>):boolean {
  if(!snapshot||typeof snapshot!=='object')return false
  const row=snapshot as Record<string,unknown>
  return row.id===record.id&&row.content===record.content&&row.project===record.project&&row.category===record.category&&row.shape===record.shape&&
    (row.createdById??row.created_by_id)===getCtx().userId&&knowledgeRequestHash(row.metadata??null)===knowledgeRequestHash(record.metadata??null)&&
    knowledgeRequestHash(row.entities??[])===knowledgeRequestHash(record.entities)&&
    (row.sessionId??row.session_id??null)===(record.sessionId??null)&&
    (record.sourceProvenance===undefined||record.sourceProvenance===(row.sourceProvenance??row.source_provenance))&&
    (record.memoryTier===undefined||record.memoryTier===(row.memoryTier??row.memory_tier))&&
    (record.confidence===undefined||record.confidence===row.confidence)&&
    legacyTimestamp(row.record_updated_at??row.recordUpdatedAt)===new Date(record.recordUpdatedAt).getTime()&&
    // Prisma's historical TIMESTAMP columns are UTC without a zone. Parse the
    // captured database representation as UTC on every host timezone.
    legacyTimestamp(row.created_at??row.createdAt)===new Date(record.createdAt).getTime()
}
function legacyTimestamp(value:unknown):number{
  const text=String(value)
  return new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(text)?text:`${text}Z`).getTime()
}

export async function knowledgeArchiveRoutes(app:FastifyInstance):Promise<void>{
  const routes=app.withTypeProvider<ZodTypeProvider>()
  routes.get('/memories/export',{schema:{querystring:z.object({project:z.string().min(1).optional(),createdById:z.string().uuid().optional()}).strict()}},async req=>{
    return runInTenant(async(tx:Tx)=>{
      const rows=await tx.memory.findMany({where:{...knowledgeWhere(req.query),...(req.query.createdById?{createdById:req.query.createdById}:{})},orderBy:[{createdAt:'asc'},{id:'asc'}],take:5001})
      if(rows.length>5000)throw new KnowledgeError('archive_limit',422,'Export at most5000 records per archive; narrow the project filter.')
      const histories=rows.length?await tx.memoryRevision.findMany({where:{memoryId:{in:rows.map(row=>row.id)}},orderBy:{revision:'asc'}}):[]
      const terms=await tx.knowledgeTerm.findMany({select:{kind:true,name:true,aliases:true,reason:true}})
      const memories=rows.map(row=>{
        const history=histories.filter(version=>version.memoryId===row.id&&version.revision<=row.revision)
        if(history.length>10000)throw new KnowledgeError('archive_history_limit',422,'Use the full database backup for records exceeding10000 historical revisions.')
        const classification=KnowledgeClassification.safeParse(row.knowledge)
        const names=classification.success?new Set([...classification.data.topicTags,...classification.data.applicability.projects??[],...classification.data.applicability.systems??[],...(classification.data.origin.name?[classification.data.origin.name]:[]),...classification.data.relationships?.map(link=>link.target.name)??[]]):new Set<string>()
        const record={id:row.id,content:row.content,project:row.project,category:row.category,shape:row.shape,entities:row.entities,sessionId:row.sessionId,createdById:row.createdById,
          createdAt:row.createdAt.toISOString(),recordUpdatedAt:row.recordUpdatedAt.toISOString(),updatedAt:row.updatedAt.toISOString(),metadata:row.metadata,
          revision:row.revision,classification:row.knowledge,sourceProvenance:row.sourceProvenance,memoryTier:row.memoryTier,confidence:row.confidence,
          relationshipDependencies:row.relationshipDependencies,catalog:terms.filter(term=>names.has(term.name)),embeddingStatus:row.embeddingStatus,graphStatus:row.graphStatus,
          revisionHistory:history.map(version=>({...version,createdAt:version.createdAt.toISOString()}))}
        return {...record,archiveSignature:archiveSignature(record)}
      })
      return {schema:'pm.memory-export/2',count:memories.length,exportedAt:new Date().toISOString(),filters:{project:req.query.project??null,createdById:req.query.createdById??null},memories}
    },{isolationLevel:'RepeatableRead'})
  })
  routes.post('/memories/import',{schema:{body:Body}},async req=>{
    const ctx=getCtx()
    const migration=await ownerPrisma.$queryRaw<Array<{finished_at:Date}>>`SELECT finished_at FROM _prisma_migrations WHERE migration_name='0031_personal_knowledge_contract' AND rolled_back_at IS NULL AND finished_at IS NOT NULL LIMIT 1`
    const cutoff=migration[0]?.finished_at
    if(!cutoff)throw new KnowledgeError('migration_required',409,'Complete the versioned knowledge migration before using archive conversion.')
    let imported=0,unchanged=0,quarantined=0
    const details:Array<{index:number;id:string;stage:string;code?:string;message:string}>=[]
    for(const[index,record]of req.body.memories.entries()){
      try{
        if(req.body.schema==='pm.memory-export/1'&&(record.classification!==undefined||record.revision!==undefined||new Date(record.createdAt)>cutoff))throw new KnowledgeError('legacy_import_not_historical',422,'The legacy converter accepts only original pre-migration records with original IDs/timestamps, never new writes or v2 metadata.')
        if(req.body.schema==='pm.memory-export/2'&&(record.revision===undefined||record.classification===undefined||!record.revisionHistory))throw new KnowledgeError('archive_metadata_missing',422,'Version 2 requires explicit revision, classification (or legacy null), and revisionHistory.')
        if(record.classification==null&&new Date(record.createdAt)>cutoff)throw new KnowledgeError('legacy_import_not_historical',422,'Unclassified archive conversion is limited to original pre-migration records; new knowledge requires the canonical classification contract.')
        if(new Date(record.recordUpdatedAt)<new Date(record.createdAt)||new Date(record.recordUpdatedAt)>new Date())throw new KnowledgeError('archive_timestamp_invalid',422,'Preserve valid original historical timestamps.')
        if(record.classification){
          const validated=KnowledgeWrite.safeParse({contractVersion:2,content:record.content,classification:record.classification,idempotencyKey:`archive:${record.id}`})
          if(!validated.success)throw new KnowledgeError('archive_classification_invalid',422,'The classified archive must satisfy the complete canonical write contract.')
        }
        await assertNoPii(JSON.stringify(archivePrivacyView(record)))
        const result=await runInTenant(async(tx:Tx)=>{
          const existing=await tx.memory.findUnique({where:{id:record.id}})
          if(existing){
            const same=existing.content===record.content&&existing.project===record.project&&existing.category===record.category&&existing.revision===(record.revision??1)&&knowledgeRequestHash(existing.knowledge)===knowledgeRequestHash(record.classification??null)
            if(!same)throw new KnowledgeError('archive_revision_conflict',409,'Import cannot overwrite an existing ID or revision. Reconcile through the version-aware update contract.')
            return 'unchanged'
          }
          const classified=record.classification??null
          // Foreign or unknown authors are preserved outside active recall.
          // A selected file or caller-supplied project cannot establish ownership.
          const ownerMatches=record.createdById===ctx.userId&&(!record.teamId||record.teamId===ctx.teamId)
          const witness=req.body.schema==='pm.memory-export/1'?await tx.memoryRevision.findFirst({where:{memoryId:record.id,intent:'legacy_snapshot'},select:{snapshot:true}}):null
          const authentic=req.body.schema==='pm.memory-export/2'?verifyArchiveRecord(record):legacyWitnessMatches(witness?.snapshot,record)
          if(ownerMatches&&req.body.schema==='pm.memory-export/2'&&!authentic)throw new KnowledgeError('archive_signature_invalid',422,'Use the unchanged export and matching preserved owner configuration. A fabricated archive cannot bypass ordinary writes.')
          const personal=ownerMatches&&authentic
          if(!personal){
            const archiveHash=knowledgeRequestHash(record)
            const prior=await tx.memoryImportQuarantine.findUnique({where:{teamId_originalId_archiveHash:{teamId:ctx.teamId!,originalId:record.id,archiveHash}}})
            if(prior)return 'quarantined'
            await tx.memoryImportQuarantine.create({data:{id:randomUUID(),teamId:ctx.teamId!,originalId:record.id,archiveHash,payload:json(record),reason:'Original author/partition does not exactly match the validated personal owner. No owner inferred from file selection, project or presence.'}})
            return 'quarantined'
          }
          const historical=req.body.schema==='pm.memory-export/1'?witness?.snapshot as Record<string,unknown>:null
          if(classified){
            // Only an authenticated archive may restore its previously accepted
            // catalog. It cannot create arbitrary unregistered classifications.
            for(const term of record.catalog??[]){
              const exists=await tx.knowledgeTerm.findUnique({where:{teamId_kind_name:{teamId:ctx.teamId!,kind:term.kind,name:term.name}}})
              if(!exists)await tx.knowledgeTerm.create({data:{teamId:ctx.teamId!,...term}})
            }
            await resolveClassification(tx,classified,[])
          }
          let row=await tx.memory.create({data:{id:record.id,teamId:ctx.teamId!,createdById:personal?ctx.userId:null,ownershipState:personal?'personal':'unresolved',
            project:record.project,content:record.content,category:record.category,shape:record.shape,entities:record.entities,sessionId:record.sessionId??null,
            createdAt:new Date(record.createdAt),recordUpdatedAt:new Date(record.recordUpdatedAt),revision:record.revision??1,
            knowledge:classified?json(classified):Prisma.DbNull,memoryType:classified?.memoryType??'legacy_unclassified',assertionStatus:classified?.assertionStatus??'legacy_unclassified',
            topicTags:classified?.topicTags??[],projectAssociations:classified?.applicability.projects??(record.project==='general'?[]:[record.project]),systemAssociations:classified?.applicability.systems??[],
            metadata:record.metadata==null?Prisma.DbNull:json(record.metadata),
            sourceProvenance:(historical?.sourceProvenance??historical?.source_provenance??record.sourceProvenance??'agent_inferred') as 'human_verified'|'api_return'|'agent_inferred',
            memoryTier:(historical?.memoryTier??historical?.memory_tier??record.memoryTier??'semantic') as 'semantic'|'episodic'|'procedural'|'working',confidence:Number(historical?.confidence??record.confidence??0.6),
            ...(classified?classificationData(classified):{}),
            relationshipDependencies:record.relationshipDependencies==null?Prisma.DbNull:json(record.relationshipDependencies),
            embeddingStatus:'pending',graphStatus:'pending',
          }})
          if(classified){await persistClaim(tx,row,classified,record.relationshipDependencies,true);row=await tx.memory.findUniqueOrThrow({where:{id:row.id}})}
          const revisions=record.revisionHistory??[]
          if(classified&&!revisions.some(version=>version.revision===row.revision))throw new KnowledgeError('archive_history_invalid',422,'A classified archive must include its accepted current revision snapshot.')
          const seen=new Set<number>()
          for(const version of revisions){
            if(seen.has(version.revision)||version.revision>row.revision)throw new KnowledgeError('archive_history_invalid',422,'History revisions must be unique and cannot exceed the accepted revision.')
            const snapshot=version.snapshot as Record<string,unknown>|null
            if(!snapshot||snapshot.id!==record.id||snapshot.revision!==version.revision)throw new KnowledgeError('archive_history_invalid',422,'Revision snapshots must identify this exact record and revision.')
            if(version.revision===row.revision&&(snapshot.content!==record.content||knowledgeRequestHash(snapshot.knowledge)!==knowledgeRequestHash(classified)))throw new KnowledgeError('archive_history_invalid',422,'The accepted snapshot must match the exported content and classification.')
            seen.add(version.revision)
            await tx.memoryRevision.create({data:{id:randomUUID(),teamId:ctx.teamId!,memoryId:row.id,revision:version.revision,snapshot:json(version.snapshot),intent:version.intent,reason:version.reason,evidence:json(version.evidence),actorId:version.actorId??null,createdAt:new Date(version.createdAt)}})
          }
          return personal?'imported':'quarantined'
        })
        if(result==='unchanged')unchanged+=1
        else{imported+=1;if(result==='quarantined')quarantined+=1}
      }catch(error){
        // Record only a stable diagnostic code, never a failed assertion or a
        // database error message (which may contain private source text).
        const code=error&&typeof error==='object'&&'code' in error?String(error.code):'archive_conversion_failed'
        req.log.warn({code,recordId:record.id},'Archive row conversion failed')
        if(details.length<100)details.push({index:index+1,id:record.id,stage:'validation',code,message:error instanceof KnowledgeError?error.message:error instanceof PiiDetectedError?`${error.payload.reason} ${error.payload.guidance}`:'The record could not be converted safely; no partial row was accepted.'})
      }
    }
    return {imported,embedded:0,pending:imported-quarantined,errors:req.body.memories.length-imported-unchanged,details,unchanged,quarantined}
  })
}
