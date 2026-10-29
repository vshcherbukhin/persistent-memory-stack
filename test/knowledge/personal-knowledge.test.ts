import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { initDb, ownerPrisma, prisma, tenantStore, runInTenant, type TenantCtx, type Tx } from '@pm/db'
import { KnowledgeWrite, KnowledgeClassification, type Classification } from '@pm/shared'
import { saveKnowledge, updateKnowledge, knowledgeWhere, knowledgeRequestHash } from '../../apps/api/src/services/knowledge.ts'
import { searchMemoriesMerged } from '../../apps/api/src/services/merge.ts'
import { __setDlpClient, __setExtractionLLM } from '../../apps/api/src/protocol/validation.ts'
import { LlmResponseError } from '../../apps/api/src/protocol/llm/client.ts'
import { archiveFixture } from '../../apps/api/test/knowledge-harness.ts'

const suffix=randomUUID().slice(0,8)
const topic=`synthetic-orbit-${suffix}`
const projects=[`synthetic-observatory-${suffix}`,`synthetic-garden-${suffix}`]
let ctx:TenantCtx
const ids:string[]=[]
const classify=vi.fn(async(_prompt:string,userJson:string)=>({outcome:'accept' as const,facts:[JSON.parse(userJson).content],restructured_content:'',reason:'',missing:[]}))
const inOwner=<T>(fn:()=>Promise<T>)=>tenantStore.run(ctx,fn)
const classification=(project:string|null,status:Classification['assertionStatus']='observation'):Classification=>({
  memoryType:'decision',assertionStatus:status,primaryTopic:topic,topicTags:[topic],origin:project?{kind:'project',name:project}:{kind:'general'},
  applicability:project?{state:'associated',projects:[project]}:{state:'general'},
  sources:[{kind:'user',reference:`synthetic-fixture:${suffix}`,evidence:'Synthetic source reports each context separately; proposal is not an accepted decision.'}],
})
const capture=(project:string|null,content:string,status:Classification['assertionStatus']='observation',key=randomUUID())=>({contractVersion:2 as const,content,classification:classification(project,status),idempotencyKey:key,
  resolutions:[{kind:'topic' as const,name:topic,action:'create' as const,reason:'Explicit synthetic retrieval-quality fixture topic.'},...(project?[{kind:'project' as const,name:project,action:'create' as const,reason:'Explicit synthetic independent project fixture.'}]:[])]})
beforeAll(async()=>{
  if(process.env.PM_TEST_STACK!=='true'||!process.env.PM_KNOWLEDGE_TEST_DATABASE_URL||!process.env.PM_KNOWLEDGE_TEST_OWNER_URL)throw new Error('Refusing mutation: provide marked isolated task-owned database URLs.')
  const runtime=new URL(process.env.PM_KNOWLEDGE_TEST_DATABASE_URL)
  if(!['127.0.0.1','localhost'].includes(runtime.hostname)||['5432','5433'].includes(runtime.port))throw new Error('Refusing a normal/local production database port.')
  initDb({databaseUrl:runtime.href,databaseMigrateUrl:process.env.PM_KNOWLEDGE_TEST_OWNER_URL})
  const marker=await ownerPrisma.$queryRaw<Array<{value:string}>>`SELECT current_setting('pm.task',true) AS value`
  if(marker[0]?.value!=='community-knowledge-01a17e67')throw new Error('Missing isolated database task marker.')
  const owner=await ownerPrisma.localIdentity.findUniqueOrThrow({where:{id:'singleton'}})
  ctx={userId:owner.userId,teamId:owner.teamId,adminLevel:'superuser',isTeamMember:true,isTeamAdmin:false,isGlobalSuperuser:true,mountedTeamIds:[],insideTenantTx:false}
  __setDlpClient({scan:async()=>({pii:[],secrets:[],block:false})})
  __setExtractionLLM({classify})
})
afterAll(async()=>{__setDlpClient(null);__setExtractionLLM(null);await Promise.allSettled([prisma?.$disconnect(),ownerPrisma?.$disconnect()])})

describe('Community canonical personal knowledge on a restored isolated database',()=>{
  it('rejects missing/conflicting metadata and server-owned fields before storage',async()=>{
    const valid=capture(projects[0]!,`Synthetic observatory ${suffix} uses orbit scheduling and has an accepted baseline.`)
    expect(KnowledgeWrite.safeParse({...valid,teamId:ctx.teamId}).success).toBe(false)
    expect(KnowledgeClassification.safeParse({...valid.classification,topicTags:['other']}).success).toBe(false)
    expect(KnowledgeClassification.safeParse({...valid.classification,assertionStatus:'fact',applicability:{state:'unresolved',reason:'The correct association is not known yet.'}}).success).toBe(false)
    await expect(inOwner(()=>saveKnowledge({content:valid.content,metadata:{category:'fix'}}))).rejects.toMatchObject({code:'memory_contract_upgrade_required'})
    await expect(inOwner(()=>saveKnowledge({...valid,resolutions:[]}))).rejects.toMatchObject({code:'classification_resolution_required'})
  })
  it('deduplicates concurrent retries and retains distinct cross-project/general assertions',async()=>{
    const first=capture(projects[0]!,`Synthetic observatory ${suffix} accepts orbit scheduling as its operating decision.`, 'fact')
    const [one,retry]=await inOwner(()=>Promise.all([saveKnowledge(first),saveKnowledge(first)])) as Array<{id:string;revision:number}>
    expect(one).toEqual(retry);ids.push(one!.id)
    await expect(inOwner(()=>saveKnowledge({...first,content:first.content+' Changed.'}))).rejects.toMatchObject({code:'idempotency_conflict'})
    const two=await inOwner(()=>saveKnowledge(capture(projects[1]!,`Synthetic garden ${suffix} proposes orbit scheduling for evaluation and has not accepted it.`,'proposal'))) as {id:string}
    const three=await inOwner(()=>saveKnowledge(capture(null,`Synthetic general conversation ${suffix} observes orbit scheduling as a recurring concept.`))) as {id:string}
    ids.push(two.id,three.id)
    const records=await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.findMany({where:{id:{in:ids}}})))
    expect(records).toHaveLength(3);expect(records.map(record=>record.assertionStatus).sort()).toEqual(['fact','observation','proposal'])
    const sourceIds=await inOwner(()=>runInTenant((tx:Tx)=>tx.claim.findMany({where:{memoryId:{in:ids}}})))
    expect(new Set(sourceIds.flatMap(claim=>claim.sourceIds)).size).toBe(1)
    const before=classify.mock.calls.length
    await inOwner(()=>saveKnowledge(first));expect(classify.mock.calls).toHaveLength(before)
  })
  it('keeps classification/evidence local and fails closed on rejected or malformed content verdicts',async()=>{
    const content=`Synthetic validator ${suffix} reports an explicit assertion with separately classified local evidence.`
    const submission=capture(null,content)
    submission.classification.primaryTopic=`synthetic-validator-${suffix}`
    submission.classification.topicTags=[submission.classification.primaryTopic]
    submission.resolutions=[{kind:'topic',name:submission.classification.primaryTopic,action:'create',reason:'Keep validator behavior separate from the shared-concept retrieval fixture.'}]
    const accepted=await inOwner(()=>saveKnowledge(submission)) as {id:string}
    expect(JSON.parse(classify.mock.calls.at(-1)![1])).toEqual({content})
    const before=await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.count()))
    classify.mockResolvedValueOnce({outcome:'reject',facts:[],restructured_content:'',reason:'Missing a self-contained assertion.',missing:['self_contained_assertion']} as never)
    await expect(inOwner(()=>saveKnowledge(capture(null,content+' Rejected.')))).rejects.toMatchObject({code:'content_validation_failed',statusCode:422})
    classify.mockRejectedValueOnce(new LlmResponseError('fixture malformed verdict'))
    await expect(inOwner(()=>updateKnowledge(accepted.id,{contractVersion:2,expectedRevision:1,intent:'correction',changes:{content:content+' Corrected.'},reason:'Synthetic malformed-validator rollback proof.',evidence:classification(null).sources,idempotencyKey:randomUUID()}))).rejects.toMatchObject({code:'content_validation_unavailable',statusCode:503})
    expect(await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.count()))).toBe(before)
    expect((await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.findUniqueOrThrow({where:{id:accepted.id}})))).revision).toBe(1)
  })
  it('scans protocol UUID values without changing receipts or weakening privacy rollback',async()=>{
    const scans:string[]=[]
    let gate:'clean'|'blocked'|'unavailable'='clean'
    __setDlpClient({scan:async text=>{
      scans.push(text)
      if(gate==='unavailable')throw new Error('Synthetic scanner outage')
      return {pii:[],secrets:gate==='blocked'?[{rule_id:'generic-api-key',description:'Synthetic blocked credential'}]:[],block:gate==='blocked'}
    }})
    try{
      const submission=capture(null,`Synthetic privacy ${suffix} preserves the literal idempotencyKey in its source assertion.`)
      const accepted=await inOwner(()=>saveKnowledge(submission)) as {id:string;revision:number}
      const createScan=JSON.parse(scans.at(-1)!)
      expect(createScan).toEqual({...submission,idempotencyKey:undefined,receiptId:submission.idempotencyKey})
      expect(createScan.content).toContain('idempotencyKey')
      const receipt=await inOwner(()=>runInTenant((tx:Tx)=>tx.memoryWriteReceipt.findUniqueOrThrow({where:{teamId_key:{teamId:ctx.teamId!,key:submission.idempotencyKey}}})))
      expect(receipt.key).toBe(submission.idempotencyKey)
      expect(receipt.requestHash).toBe(knowledgeRequestHash({operation:'create',input:submission}))
      const update={contractVersion:2 as const,expectedRevision:1,intent:'correction' as const,changes:{content:submission.content+' This source supplied a correction.'},reason:'Explicit synthetic privacy correction.',evidence:submission.classification.sources,idempotencyKey:randomUUID()}
      const corrected=await inOwner(()=>updateKnowledge(accepted.id,update)) as {revision:number}
      expect(corrected.revision).toBe(2)
      const updateScan=JSON.parse(scans.at(-1)!)
      expect(updateScan.input).toEqual({...update,idempotencyKey:undefined,receiptId:update.idempotencyKey})
      expect(updateScan.resulting).toMatchObject({content:update.changes.content,classification:submission.classification,receiptId:update.idempotencyKey})
      const beforeReplay={scans:scans.length,models:classify.mock.calls.length}
      expect(await inOwner(()=>saveKnowledge(submission))).toEqual(accepted)
      expect(await inOwner(()=>updateKnowledge(accepted.id,update))).toEqual(corrected)
      await expect(inOwner(()=>saveKnowledge({...submission,content:submission.content+' Changed retry.'}))).rejects.toMatchObject({code:'idempotency_conflict'})
      expect({scans:scans.length,models:classify.mock.calls.length}).toEqual(beforeReplay)
      const counts=()=>inOwner(()=>runInTenant(async(tx:Tx)=>({rows:await tx.memory.count(),history:await tx.memoryRevision.count(),receipts:await tx.memoryWriteReceipt.count()})))
      const before=await counts(),models=classify.mock.calls.length
      gate='blocked'
      await expect(inOwner(()=>saveKnowledge(capture(null,submission.content+' Blocked.')))).rejects.toMatchObject({code:'pii_detected'})
      await expect(inOwner(()=>updateKnowledge(accepted.id,{...update,expectedRevision:2,idempotencyKey:randomUUID()}))).rejects.toMatchObject({code:'pii_detected'})
      gate='unavailable'
      await expect(inOwner(()=>saveKnowledge(capture(null,submission.content+' Scanner unavailable.')))).rejects.toMatchObject({code:'pii_detected'})
      expect(classify.mock.calls.length).toBe(models)
      expect(await counts()).toEqual(before)
      expect((await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.findUniqueOrThrow({where:{id:accepted.id}})))).revision).toBe(2)
    }finally{__setDlpClient({scan:async()=>({pii:[],secrets:[],block:false})})}
  })
  it('recalls both projects and general across the owner space, with strict filters and bounded results',async()=>{
    const noVectors={query: `${suffix} orbit scheduling`,pin:{modelId:'synthetic',dim:2,vectorName:'synthetic'},limit:10}
    const all=await inOwner(()=>searchMemoriesMerged({} as never,noVectors))
    expect(new Set(all.results.map(row=>row.id))).toEqual(new Set(ids))
    const filtered=await inOwner(()=>searchMemoriesMerged({} as never,{...noVectors,project:projects[1]!,assertionStatus:'proposal'}))
    expect(filtered.results.map(row=>row.id)).toEqual([ids[1]])
    const zero=await inOwner(()=>searchMemoriesMerged({} as never,{...noVectors,project:'does-not-exist'}))
    expect(zero.results).toEqual([])
    const topicFiltered=await inOwner(()=>searchMemoriesMerged({} as never,{...noVectors,topic:'nonexistent-topic'}));expect(topicFiltered.results).toEqual([])
    const timeFiltered=await inOwner(()=>searchMemoriesMerged({} as never,{...noVectors,createdBefore:'2000-01-01T00:00:00.000Z'}));expect(timeFiltered.results).toEqual([])
    await expect(inOwner(()=>searchMemoriesMerged({} as never,{...noVectors,project:'',projects:[projects[0]!]}))).rejects.toMatchObject({code:'memory_filter_invalid'})
    await expect(inOwner(()=>searchMemoriesMerged({} as never,{...noVectors,createdAfter:'2030-01-01T00:00:00.000Z',createdBefore:'2000-01-01T00:00:00.000Z'}))).rejects.toMatchObject({code:'memory_filter_invalid'})
    expect(Buffer.byteLength(JSON.stringify(all))).toBeLessThan(24000)
  })
  it('rejects stale concurrent updates and preserves exact accepted revision history',async()=>{
    const update={contractVersion:2 as const,expectedRevision:1,intent:'correction' as const,changes:{content:`Synthetic observatory ${suffix} corrects its orbit scheduling decision with explicit source evidence.`},reason:'Synthetic source corrected the earlier wording.',evidence:classification(projects[0]!).sources,idempotencyKey:randomUUID()}
    const attempts=await inOwner(()=>Promise.allSettled([updateKnowledge(ids[0]!,update),updateKnowledge(ids[0]!,{...update,idempotencyKey:randomUUID()})]))
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(attempts.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'revision_conflict'}})
    const history=await inOwner(()=>runInTenant((tx:Tx)=>tx.memoryRevision.findMany({where:{memoryId:ids[0]},orderBy:{revision:'asc'}})))
    expect(history.map(row=>row.revision)).toEqual([1,2])
    expect(history[1]?.reason).toBe(update.reason)
  })
  it('ignores obsolete mounted/read-all options and excludes legacy foreign/unresolved ownership',async()=>{
    const legacy=await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.findFirst({where:{memoryType:'legacy_unclassified'},select:{id:true,revision:true,memoryType:true}})))
    expect(legacy?.memoryType).toBe('legacy_unclassified')
    const wrong={...ctx,teamId:randomUUID(),mountedTeamIds:[ctx.teamId!],isGlobalSuperuser:true}
    const leaked=await tenantStore.run(wrong,()=>runInTenant((tx:Tx)=>tx.memory.findMany({where:{id:{in:ids}}}),{globalAdmin:true,readAllMemory:true}))
    expect(leaked).toEqual([])
    expect(knowledgeWhere({project:'exact-project'})).toMatchObject({ownershipState:'personal',deletedAt:null})
  })
  it('reports preserved legacy graph state without rewriting historical failures',async()=>{
    const id='00000000-0000-4000-8000-000000000001'
    await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.update({where:{id},data:{graphStatus:'failed'}})))
    const before=classify.mock.calls.length
    const result=await inOwner(()=>searchMemoriesMerged({} as never,{query:'Synthetic positively owned legacy knowledge',project:'synthetic-owner-filter',pin:{modelId:'synthetic',dim:2,vectorName:'synthetic'},limit:5}))
    expect(result.results.map(row=>({id:row.id,graphStatus:row.graphStatus,classificationStatus:row.classificationStatus}))).toEqual([{id,graphStatus:'legacy_preserved',classificationStatus:'legacy_unclassified'}])
    expect((await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.findUniqueOrThrow({where:{id}})))).graphStatus).toBe('failed')
    expect(classify.mock.calls.length).toBe(before)
  })
  it('hashes requests deterministically without equating records from different projects',()=>{
    expect(knowledgeRequestHash({a:1,b:2})).toBe(knowledgeRequestHash({b:2,a:1}))
    expect(knowledgeRequestHash(capture(projects[0]!, 'A synthetic self contained source statement with forty characters.'))).not.toBe(knowledgeRequestHash(capture(projects[1]!, 'A synthetic self contained source statement with forty characters.')))
  })
  it('round-trips v2 archives without overwriting a revision and quarantines foreign legacy evidence',async()=>{
    const app=await archiveFixture(ctx)
    const exported=await app.inject({method:'GET',url:`/memories/export?project=${encodeURIComponent(projects[0]!)}`})
    expect(exported.statusCode).toBe(200)
    const envelope=exported.json()
    expect(envelope.schema).toBe('pm.memory-export/2')
    expect(envelope.memories[0].revision).toBe(2)
    expect(envelope.memories[0].revisionHistory.map((version:{revision:number})=>version.revision)).toEqual([1,2])
    const duplicate=await app.inject({method:'POST',url:'/memories/import',payload:{schema:envelope.schema,ownerConfirmation:true,memories:envelope.memories}})
    expect(duplicate.statusCode).toBe(200);expect(duplicate.json().unchanged).toBe(1)
    const fakeNew=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/1',ownerConfirmation:true,memories:[{id:randomUUID(),content:'A purported new memory cannot bypass canonical classification.'}]}})
    expect(fakeNew.statusCode).toBe(400)
    const foreignId=randomUUID()
    const foreign={id:foreignId,content:'Synthetic foreign legacy evidence is retained without entering personal recall.',project:'foreign-synthetic',category:'fix',shape:'atomic',entities:[],createdById:randomUUID(),createdAt:'2020-01-01T00:00:00.000Z',recordUpdatedAt:'2020-01-01T00:00:00.000Z'}
    const result=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/1',ownerConfirmation:true,memories:[foreign]}})
    expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({imported:1,quarantined:1,errors:0})
    const state=await inOwner(()=>runInTenant(async(tx:Tx)=>({active:await tx.memory.count({where:{id:foreignId}}),quarantined:await tx.memoryImportQuarantine.count({where:{originalId:foreignId}})})))
    expect(state).toEqual({active:0,quarantined:1})
    await app.close()
  })
  it('rejects forged classified archives and unverified legacy ownership, and restores an authenticated exact revision',async()=>{
    const app=await archiveFixture(ctx)
    try {
      const saved=await inOwner(()=>saveKnowledge(capture(null,`Synthetic archive ${suffix} preserves only authenticated accepted revisions and local source evidence.`))) as {id:string}
      const exported=await app.inject({method:'GET',url:'/memories/export'})
      expect(exported.statusCode,exported.body).toBe(200)
      const record=exported.json().memories.find((row:{id:string})=>row.id===saved.id)
      expect(record.archiveSignature).toMatch(/^[a-f0-9]{64}$/)
      const fabricated={...record,id:randomUUID(),sourceProvenance:'human_verified',confidence:1}
      const rejected=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/2',ownerConfirmation:true,memories:[fabricated]}})
      expect(rejected.json()).toMatchObject({imported:0,errors:1})
      const short=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/2',ownerConfirmation:true,memories:[{...fabricated,id:randomUUID(),content:'x'}]}})
      expect(short.json()).toMatchObject({imported:0,errors:1})
      // Cluster-owner operations are confined by beforeAll's task marker/port checks.
      // A restore copy deliberately lacks the accepted row and history.
      await ownerPrisma.memory.delete({where:{id:saved.id}})
      await ownerPrisma.memoryRevision.deleteMany({where:{memoryId:saved.id}})
      const restored=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/2',ownerConfirmation:true,memories:[record]}})
      expect(restored.json(),restored.body).toMatchObject({imported:1,errors:0,quarantined:0})
      const row=await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.findUniqueOrThrow({where:{id:saved.id}})))
      expect(row.revision).toBe(record.revision);expect(row.content).toBe(record.content)
      expect(row.sourceProvenance).toBe('agent_inferred');expect(row.confidence).toBeLessThan(1)
      const fabricatedLegacy={id:randomUUID(),content:'Synthetic ownership is never established merely by copying the local author ID.',project:'general',category:'fix',shape:'atomic',entities:[],createdById:ctx.userId,createdAt:'2020-01-01T00:00:00.000Z',recordUpdatedAt:'2020-01-01T00:00:00.000Z'}
      const quarantined=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/1',ownerConfirmation:true,memories:[fabricatedLegacy]}})
      expect(quarantined.json()).toMatchObject({imported:1,quarantined:1,errors:0})
      expect(await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.count({where:{id:fabricatedLegacy.id}})))).toBe(0)
    } finally { await app.close() }
  })
  it('scans archive semantic data while restoring exact numeric UUID identities and authenticated history',async()=>{
    const id='11111111-1111-4111-8111-111111111111'
    if(await ownerPrisma.memory.findUnique({where:{id}}))throw new Error('Refusing an occupied synthetic archive fixture ID')
    const row=await ownerPrisma.memory.create({data:{id,teamId:ctx.teamId!,createdById:ctx.userId,ownershipState:'personal',content:'Synthetic historical archive evidence preserves its numeric UUID and original source data.',project:`synthetic-archive-privacy-${suffix}`,category:'fact',shape:'atomic',entities:[],createdAt:new Date('2020-01-01T00:00:00.000Z'),recordUpdatedAt:new Date('2020-01-01T00:00:00.000Z')}})
    await ownerPrisma.memoryRevision.create({data:{id:randomUUID(),teamId:ctx.teamId!,memoryId:id,revision:1,snapshot:JSON.parse(JSON.stringify(row)),intent:'legacy_snapshot',reason:'Synthetic pre-migration archive fixture.',evidence:[],actorId:ctx.userId,createdAt:row.createdAt}})
    const app=await archiveFixture(ctx),scans:string[]=[]
    const clean=()=>__setDlpClient({scan:async text=>{scans.push(text);return {pii:[],secrets:[],block:false}}})
    const countState=()=>inOwner(()=>runInTenant(async(tx:Tx)=>({rows:await tx.memory.count(),history:await tx.memoryRevision.count(),receipts:await tx.memoryWriteReceipt.count(),catalog:await tx.knowledgeTerm.count()})))
    const importRecord=(record:unknown)=>app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/2',ownerConfirmation:true,memories:[record]}})
    try{
      clean()
      const exported=await app.inject({method:'GET',url:`/memories/export?project=${row.project}`})
      expect(exported.statusCode).toBe(200)
      const record=exported.json().memories[0]
      expect(record.id).toBe(id)
      const beforeModels=classify.mock.calls.length
      expect((await importRecord(record)).json()).toMatchObject({errors:0,unchanged:1})
      expect(scans).toHaveLength(1) // Unchanged imports still pass the privacy gate.
      expect(JSON.parse(scans[0]!)).toMatchObject({id:'[validated memory identifier]',revisionHistory:[{memoryId:'[validated memory identifier]',snapshot:{id:'[validated memory identifier]'}}]})
      const before=await countState()
      __setDlpClient({scan:async()=>({pii:[{entity_type:'EMAIL_ADDRESS',start:0,end:1,score:1}],secrets:[],block:true})})
      expect((await importRecord(record)).json()).toMatchObject({imported:0,errors:1})
      __setDlpClient({scan:async()=>{throw new Error('Synthetic scanner outage')}})
      expect((await importRecord(record)).json()).toMatchObject({imported:0,errors:1})
      expect(await countState()).toEqual(before)
      expect(classify.mock.calls.length).toBe(beforeModels)
      clean()
      // Only this positively identified synthetic row in the marked restore DB.
      await ownerPrisma.memory.delete({where:{id}})
      await ownerPrisma.memoryRevision.deleteMany({where:{memoryId:id}})
      const tampered={...record,revisionHistory:record.revisionHistory.map((version:{snapshot:object})=>({...version,snapshot:{...version.snapshot,id:randomUUID()}}))}
      expect((await importRecord(tampered)).json()).toMatchObject({imported:0,errors:1})
      expect(await ownerPrisma.memory.count({where:{id}})).toBe(0)
      expect((await importRecord(record)).json()).toMatchObject({imported:1,errors:0,quarantined:0})
      const restored=await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.findUniqueOrThrow({where:{id}})))
      const history=await inOwner(()=>runInTenant((tx:Tx)=>tx.memoryRevision.findMany({where:{memoryId:id}})))
      expect(restored.id).toBe(id);expect(restored.content).toBe(row.content)
      expect(restored.recordUpdatedAt).toEqual(row.recordUpdatedAt)
      expect(history).toHaveLength(1)
      expect(history[0]!.snapshot).toEqual(record.revisionHistory[0].snapshot)
      expect(JSON.stringify(restored)).not.toContain('[validated memory identifier]')
      expect(JSON.stringify(history)).not.toContain('[validated memory identifier]')
      expect(classify.mock.calls.length).toBe(beforeModels)
    }finally{__setDlpClient({scan:async()=>({pii:[],secrets:[],block:false})});await app.close()}
  })
  it('withholds memory relationships after the target changes or is deleted',async()=>{
    const app=await archiveFixture(ctx)
    try {
      const target=await inOwner(()=>saveKnowledge(capture(null,`Synthetic target ${suffix} reports evidence that may be corrected independently of its dependent claim.`))) as {id:string}
      const input=capture(null,`Synthetic dependent ${suffix} reports a qualified relationship to the exact target accepted revision.`)
      input.classification.relationships=[{type:'SUPPORTED_BY',target:{kind:'memory',name:target.id},status:'source_supported',sourceReferences:input.classification.sources.map(source=>source.reference)}]
      const dependent=await inOwner(()=>saveKnowledge(input)) as {id:string}
      const links=()=>app.inject({method:'GET',url:`/memories/${dependent.id}/relationships`})
      const before=(await links()).json()
      expect(before.relationships.some((link:{metadata:{targetMemoryId?:string}})=>link.metadata.targetMemoryId===target.id)).toBe(true)
      await inOwner(()=>updateKnowledge(target.id,{contractVersion:2,expectedRevision:1,intent:'correction',changes:{content:`Synthetic target ${suffix} corrects its former evidence; dependent support must be reviewed again.`},reason:'Synthetic source correction invalidates the earlier supporting revision.',evidence:classification(null).sources,idempotencyKey:randomUUID()}))
      const after=(await links()).json()
      expect(after.invalidatedCount).toBe(1)
      expect(after.relationships.some((link:{metadata:{targetMemoryId?:string}})=>link.metadata.targetMemoryId===target.id)).toBe(false)
      await ownerPrisma.memory.update({where:{id:target.id},data:{deletedAt:new Date()}})
      expect((await links()).json().invalidatedCount).toBe(1)
    } finally { await app.close() }
  })
  it('requires the exact witnessed legacy state, including certainty, entities and timestamps',async()=>{
    const fixtureId='00000000-0000-4000-8000-000000000001'
    const witness=await ownerPrisma.memoryRevision.findUniqueOrThrow({where:{memoryId_revision:{memoryId:fixtureId,revision:1}}})
    const old=witness.snapshot as Record<string,unknown>
    const utc=(value:unknown)=>{const text=String(value);return new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(text)?text:`${text}Z`).toISOString()}
    const record={id:fixtureId,content:old.content,project:old.project,category:old.category,shape:old.shape,entities:old.entities,metadata:old.metadata,sessionId:old.session_id,createdById:old.created_by_id,createdAt:utc(old.created_at),recordUpdatedAt:utc(old.record_updated_at),sourceProvenance:old.source_provenance,memoryTier:old.memory_tier,confidence:old.confidence}
    const app=await archiveFixture(ctx)
    try{
      await ownerPrisma.memory.deleteMany({where:{id:fixtureId}})
      const forged=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/1',ownerConfirmation:true,memories:[{...record,sourceProvenance:'human_verified',confidence:1,entities:['forged-certainty'],recordUpdatedAt:new Date().toISOString()}]}})
      expect(forged.json()).toMatchObject({quarantined:1})
      expect(await inOwner(()=>runInTenant((tx:Tx)=>tx.memory.count({where:{id:fixtureId}})))).toBe(0)
      const restored=await app.inject({method:'POST',url:'/memories/import',payload:{schema:'pm.memory-export/1',ownerConfirmation:true,memories:[record]}})
      expect(restored.json(),restored.body).toMatchObject({imported:1,quarantined:0,errors:0})
      const row=await ownerPrisma.memory.findUniqueOrThrow({where:{id:fixtureId}})
      expect(row.sourceProvenance).toBe(record.sourceProvenance);expect(row.confidence).toBe(record.confidence);expect(row.entities).toEqual(record.entities);expect(row.recordUpdatedAt.toISOString()).toBe(record.recordUpdatedAt)
    }finally{await app.close()}
  })
  it('denies cached and unresolved same-partition document evidence while allowing an explicitly owned upload',async()=>{
    const fixture=async(personal:boolean)=>{
      const source=await ownerPrisma.source.create({data:{teamId:ctx.teamId!,kind:'document',ownerId:personal?ctx.userId:null,ownershipState:personal?'personal':'unresolved',metadata:personal?{}:{cachedRemote:true}}})
      const doc=await ownerPrisma.document.create({data:{teamId:ctx.teamId!,sourceId:source.id,minioObjectKey:`synthetic-only/${source.id}`}})
      const chunk=await ownerPrisma.chunk.create({data:{teamId:ctx.teamId!,documentId:doc.id,ordinal:0,content:'Synthetic document evidence must inherit proven source ownership.'}})
      return {source,doc,chunk}
    }
    const owned=await fixture(true),cached=await fixture(false)
    const visible=await inOwner(()=>runInTenant(async(tx:Tx)=>({documents:await tx.document.findMany({where:{id:{in:[owned.doc.id,cached.doc.id]}}}),chunks:await tx.chunk.findMany({where:{id:{in:[owned.chunk.id,cached.chunk.id]}}})})))
    expect(visible.documents.map(row=>row.id)).toEqual([owned.doc.id]);expect(visible.chunks.map(row=>row.id)).toEqual([owned.chunk.id])
    const investigations=await Promise.all([ctx.userId,null,randomUUID()].map(ownerId=>ownerPrisma.investigation.create({data:{teamId:ctx.teamId!,title:'Synthetic investigation ownership fixture',ownerId,ownershipState:'personal'}})))
    for(const investigation of investigations)await ownerPrisma.investigationLink.create({data:{teamId:ctx.teamId!,investigationId:investigation.id,targetType:'memory',targetId:ids[0]!}})
    const investigationIds=investigations.map(row=>row.id)
    const readable=await inOwner(()=>runInTenant(async(tx:Tx)=>({investigations:await tx.investigation.findMany({where:{id:{in:investigationIds}}}),links:await tx.investigationLink.findMany({where:{investigationId:{in:investigationIds}}})})))
    expect(readable.investigations.map(row=>row.id)).toEqual([investigations[0]!.id]);expect(readable.links.map(row=>row.investigationId)).toEqual([investigations[0]!.id])
  })
})
