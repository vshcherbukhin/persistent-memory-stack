/** One authoritative classified-write path for API, MCP and dashboard adapters. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getCtx, runInTenant, Prisma, type Tx } from '@pm/db'
import {
  KnowledgeWrite, KnowledgeUpdate, KnowledgeClassification, KnowledgeFilters, KNOWLEDGE_UPGRADE_GUIDANCE,
  type Classification, type ClassifiedWrite, type ClassifiedUpdate, type KnowledgeFilter,
} from '@pm/shared'
import { assertNoPii, classifyKnowledgeContent } from '../protocol/validation.ts'
import { LlmResponseError } from '../protocol/llm/client.ts'

export class KnowledgeError extends Error {
  constructor(public code: string, public statusCode: number, message: string, public details: unknown = null) { super(message) }
}

export function parseKnowledge<T>(schema: z.ZodType<T>, value: unknown): T {
  if (!value || typeof value !== 'object' || !('contractVersion' in value) || value.contractVersion !== 2) {
    throw new KnowledgeError('memory_contract_upgrade_required', 422, KNOWLEDGE_UPGRADE_GUIDANCE, { contractVersion: 2, discoveryTool: 'memory_catalog' })
  }
  const result = schema.safeParse(value)
  if (!result.success) throw new KnowledgeError('memory_classification_invalid', 422, 'Correct the fields listed in issues; no record was changed.', { issues: result.error.issues })
  return result.data
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  return value
}
export function knowledgeRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue }

/** Relational filters are authoritative; index payloads and hints cannot widen them. */
export function knowledgeWhere(filter: KnowledgeFilter = {}): Prisma.MemoryWhereInput {
  const selected = Object.fromEntries(Object.keys(KnowledgeFilters.shape).filter(key => (filter as Record<string, unknown>)[key] !== undefined).map(key => [key, (filter as Record<string, unknown>)[key]]))
  const parsed = KnowledgeFilters.safeParse(selected)
  if (!parsed.success) throw new KnowledgeError('memory_filter_invalid', 422, 'Correct the explicit filters; conflicting or empty filters are never silently broadened.', { issues: parsed.error.issues })
  filter = parsed.data
  const projects = filter.projects ?? (filter.project ? [filter.project] : undefined)
  return {
    ownershipState: 'personal', deletedAt: null,
    ...(projects ? { OR: [{ projectAssociations: { hasSome: projects } }, { project: { in: projects } }] } : {}),
    ...(filter.topic ? { topicTags: { has: filter.topic } } : {}),
    ...(filter.memoryType ? { memoryType: filter.memoryType } : {}),
    ...(filter.assertionStatus ? { assertionStatus: filter.assertionStatus } : {}),
    ...(filter.createdAfter || filter.createdBefore ? { createdAt: { ...(filter.createdAfter ? { gte: new Date(filter.createdAfter) } : {}), ...(filter.createdBefore ? { lte: new Date(filter.createdBefore) } : {}) } } : {}),
  }
}

export async function resolveClassification(tx: Tx, classification: Classification, resolutions: ClassifiedWrite['resolutions']): Promise<Classification> {
  const teamId = getCtx().teamId!
  const required = [
    ...classification.topicTags.map(name => ({ kind: 'topic', name })),
    ...(classification.applicability.projects ?? []).map(name => ({ kind: 'project', name })),
    ...(classification.applicability.systems ?? []).map(name => ({ kind: 'system', name })),
    ...(classification.origin.name ? [{ kind: classification.origin.kind, name: classification.origin.name }] : []),
    ...(classification.relationships ?? []).flatMap(link => ['topic', 'project', 'system'].includes(link.target.kind) ? [{ kind: link.target.kind, name: link.target.name }] : []),
  ]
  for (const resolution of resolutions ?? []) {
    if (!required.some(term => term.kind === resolution.kind && term.name === resolution.name)) throw new KnowledgeError('unused_resolution', 422, 'Resolutions may create only terms used by this record.')
  }
  const mapped = new Map<string, string>()
  for (const term of required) {
    const matches = await tx.knowledgeTerm.findMany({ where: { teamId, kind: term.kind, OR: [{ name: term.name }, { aliases: { has: term.name } }] }, take: 2 })
    if (matches.length > 1) throw new KnowledgeError('classification_ambiguous', 422, 'The alias has multiple catalog matches; choose an exact catalog name.', { field: term.kind, value: term.name })
    let resolved = matches[0]?.name
    if (!resolved) {
      const resolution = resolutions?.find(entry => entry.kind === term.kind && entry.name === term.name)
      if (!resolution) {
        const choices = await tx.knowledgeTerm.findMany({ where: { teamId, kind: term.kind }, select: { name: true }, take: 20, orderBy: { name: 'asc' } })
        throw new KnowledgeError('classification_resolution_required', 422, 'Use an existing catalog name/alias or explicitly create this term with a reason (at most eight resolutions per write).', { kind: term.kind, value: term.name, choices: choices.map(choice => choice.name) })
      }
      // Serialized per owner below: concurrent first-use terms cannot race.
      await tx.knowledgeTerm.create({ data: { teamId, kind: term.kind, name: term.name, reason: resolution.reason } })
      resolved = term.name
    }
    mapped.set(`${term.kind}:${term.name}`, resolved)
  }
  const lookup = (kind: string, name: string) => mapped.get(`${kind}:${name}`) ?? name
  return KnowledgeClassification.parse({
    ...classification,
    primaryTopic: lookup('topic', classification.primaryTopic), topicTags: classification.topicTags.map(name => lookup('topic', name)),
    origin: { ...classification.origin, ...(classification.origin.name ? { name: lookup(classification.origin.kind, classification.origin.name) } : {}) },
    applicability: { ...classification.applicability,
      ...(classification.applicability.projects ? { projects: classification.applicability.projects.map(name => lookup('project', name)) } : {}),
      ...(classification.applicability.systems ? { systems: classification.applicability.systems.map(name => lookup('system', name)) } : {}),
    },
  })
}

export function classificationData(classification: Classification) {
  return {
    knowledge: json(classification), memoryType: classification.memoryType, assertionStatus: classification.assertionStatus,
    topicTags: classification.topicTags, projectAssociations: classification.applicability.projects ?? [], systemAssociations: classification.applicability.systems ?? [],
    project: classification.origin.kind === 'project' ? classification.origin.name! : 'general',
    category: classification.memoryType, shape: 'atomic' as const,
    entities: [...new Set([...(classification.entities ?? []), ...classification.topicTags.map(topic => `topic_${topic.replaceAll('-', '_')}`)])],
    memoryTier: classification.memoryType === 'event' ? 'episodic' as const : classification.memoryType === 'procedure' ? 'procedural' as const : 'semantic' as const,
    // A caller's source label does not independently verify the assertion.
    sourceProvenance: 'agent_inferred' as const,
    confidence: classification.assertionStatus === 'inference' ? 0.4 : classification.assertionStatus === 'proposal' ? 0.5 : 0.6,
  }
}

/** Reuse the ingestion source/claim/entity/relationship models. One source event
 * can support multiple claims; exact catalog identity, never similarity, resolves
 * concepts. Current projections are fenced by accepted memory revision. */
export async function persistClaim(tx: Tx, row: KnowledgeRow & { teamId: string }, classification: Classification, previousDependencies?: unknown, allowUnavailableTargets = false): Promise<void> {
  const previous = Array.isArray(previousDependencies) ? previousDependencies as Array<{ linkHash: string; targetMemoryId: string; targetRevision: number }> : []
  const dependencies: typeof previous = []
  const sourceIds: string[] = []
  for (const source of classification.sources) {
    const sourceFingerprint = knowledgeRequestHash(source)
    const event = await tx.source.upsert({ where: { teamId_sourceFingerprint: { teamId: row.teamId, sourceFingerprint } },
      create: { teamId: row.teamId, ownerId: getCtx().userId, ownershipState: 'personal', project: row.project, sourceFingerprint, kind: source.kind === 'user' ? 'conversation' : source.kind === 'document' ? 'document' : 'memory',
        uri: source.reference, metadata: json({ kind: source.kind, evidence: source.evidence, verification: 'source_reported', origin: classification.origin }) }, update: {},
    })
    sourceIds.push(event.id)
  }
  const entity = async (kind: string, name: string) => {
    const resolutionKey = kind === 'entity' ? `${kind}:${classification.origin.kind}:${classification.origin.name ?? 'general'}:${name}` : `${kind}:${name}`
    return tx.entity.upsert({ where: { teamId_resolutionKey: { teamId: row.teamId, resolutionKey } },
    create: { teamId: row.teamId, project: 'general', name, entityType: kind, resolutionKey, metadata: json({ resolution: 'exact_validated_name', origin: classification.origin, ownership: 'personal' }) }, update: {},
  })
  }
  const subject = await entity('memory', row.id)
  const existingClaim = await tx.claim.findUnique({ where: { memoryId_memoryRevision: { memoryId: row.id, memoryRevision: row.revision } } })
  if (existingClaim) {
    const metadata = existingClaim.metadata as { classification?: unknown } | null
    if (existingClaim.statement !== row.content || knowledgeRequestHash(metadata?.classification) !== knowledgeRequestHash(classification)) throw new KnowledgeError('projection_conflict', 409, 'Existing source evidence disagrees with the accepted archive revision; restore the consistent database snapshot.')
  } else await tx.claim.create({ data: { teamId: row.teamId, project: row.project, memoryId: row.id, memoryRevision: row.revision,
    statement: row.content, sourceIds, subjectEntityId: subject.id, metadata: json({ classification, verification: 'source_reported', acceptedRevision: row.revision }) } })
  // Derived links may survive a partial row restoration; replace only this
  // exact accepted revision instead of accumulating duplicate projections.
  await tx.relationship.deleteMany({ where: { memoryId: row.id, memoryRevision: row.revision } })
  const relate = async (predicate: string, targetKind: string, targetName: string, status: string, references: string[]) => {
    let dependency: (typeof previous)[number] | null = null
    if (targetKind === 'memory') {
      const target = await tx.memory.findUnique({ where: { id: targetName } })
      const linkHash = knowledgeRequestHash({ predicate, targetKind, targetName, status, references })
      const prior = previous.find(item => item.linkHash === linkHash)
      if (!target && !prior && !allowUnavailableTargets) throw new KnowledgeError('relationship_target_unreadable', 422, 'A relationship cannot target a missing, foreign, unresolved-owner or deleted record.')
      dependency = prior ?? (target ? { linkHash, targetMemoryId: target.id, targetRevision: target.revision } : null)
      if (dependency) dependencies.push(dependency)
      if (!target || (dependency && target.revision !== dependency.targetRevision)) return // retained source assertion; derived link is invalidated
    } else if (['topic', 'project', 'system'].includes(targetKind)) {
      const target = await tx.knowledgeTerm.findUnique({ where: { teamId_kind_name: { teamId: row.teamId, kind: targetKind, name: targetName } } })
      if (!target) throw new KnowledgeError('relationship_target_unresolved', 422, 'Use an exact validated catalog target; similarity does not resolve relationships.')
    } else if (targetKind === 'entity' && !classification.entities?.includes(targetName)) {
      throw new KnowledgeError('relationship_target_unresolved', 422, 'Explicit entity targets must appear in the classified entity list.')
    }
    const target = await entity(targetKind, targetName)
    await tx.relationship.create({ data: { teamId: row.teamId, project: row.project, subjectEntityId: subject.id, objectEntityId: target.id,
      predicate, memoryId: row.id, memoryRevision: row.revision, metadata: json({ status, sourceReferences: references, assertionStatus: classification.assertionStatus, verification: 'source_reported', ...(dependency ?? {}) }) } })
  }
  await relate('ABOUT', 'topic', classification.primaryTopic, 'classified', classification.sources.map(source => source.reference))
  for (const sourceId of sourceIds) {
    const target = await entity('source', sourceId)
    await tx.relationship.create({ data: { teamId: row.teamId, project: row.project, subjectEntityId: subject.id, objectEntityId: target.id,
      predicate: 'SUPPORTED_BY', memoryId: row.id, memoryRevision: row.revision, metadata: json({ status: 'source_reported', sourceId }) } })
  }
  for (const relationship of classification.relationships ?? []) await relate(relationship.type, relationship.target.kind, relationship.target.name, relationship.status, relationship.sourceReferences)
  await tx.memory.update({ where: { id: row.id }, data: { ...(sourceIds[0] ? { sourceId: sourceIds[0] } : {}), relationshipDependencies: json(dependencies) } })
}

type KnowledgeRow = { id: string; content: string; revision: number; knowledge: unknown; memoryType: string; assertionStatus: string; project: string; category: string; entities: string[]; embeddingStatus: string; graphStatus: string; createdAt: Date; recordUpdatedAt: Date }
export function knowledgeResult(row: KnowledgeRow) {
  return { id: row.id, content: row.content, revision: row.revision, classification: row.knowledge,
    classificationStatus: row.knowledge ? 'classified' : 'legacy_unclassified', memoryType: row.memoryType, assertionStatus: row.assertionStatus,
    project: row.project, category: row.category, entities: row.entities,
    saved: true, embeddingStatus: row.embeddingStatus, graphStatus: row.graphStatus,
    searchable: true, processing: row.embeddingStatus === 'pending' || row.graphStatus === 'pending',
    verification: 'source_reported', createdAt: row.createdAt.toISOString(), recordUpdatedAt: row.recordUpdatedAt.toISOString(),
  }
}

async function withReceipt(key: string, request: unknown, apply: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  const teamId = getCtx().teamId
  if (!teamId) throw new KnowledgeError('personal_owner_required', 403, 'A validated personal owner is required.')
  const requestHash = knowledgeRequestHash(request)
  return runInTenant(async (tx: Tx) => {
    // One bounded metadata/record transaction per owner. No model/network calls
    // run under this lock; it also serializes concurrent catalog resolutions.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge:${teamId}`}, 0))`
    const prior = await tx.memoryWriteReceipt.findUnique({ where: { teamId_key: { teamId, key } } })
    if (prior) {
      if (prior.requestHash !== requestHash) throw new KnowledgeError('idempotency_conflict', 409, 'This idempotency key already belongs to a different request. Reuse the exact original request or choose a new key.')
      return prior.response
    }
    const response = await apply(tx)
    await tx.memoryWriteReceipt.create({ data: { teamId, key, requestHash, response: json(response) } })
    return response
  })
}

async function existingReceipt(key:string,request:unknown):Promise<{response:unknown}|null>{
  const teamId=getCtx().teamId
  if(!teamId)throw new KnowledgeError('personal_owner_required',403,'A validated personal owner is required.')
  const receipt=await runInTenant((tx:Tx)=>tx.memoryWriteReceipt.findUnique({where:{teamId_key:{teamId,key}}}))
  if(!receipt)return null
  if(receipt.requestHash!==knowledgeRequestHash(request))throw new KnowledgeError('idempotency_conflict',409,'This retry key belongs to a different request; no new validation or write was performed.')
  return {response:receipt.response}
}
async function assertKnowledgeContent(content:string):Promise<void>{
  let verdict
  try{verdict=await classifyKnowledgeContent(content)}catch(error){
    if(error instanceof LlmResponseError)throw new KnowledgeError('content_validation_unavailable',503,'The configured validator returned a malformed verdict. Retry; no knowledge was saved.')
    throw error
  }
  if(verdict.outcome!=='accept')throw new KnowledgeError('content_validation_failed',422,'Clarify the assertion and retry; no knowledge was saved.',{reason:verdict.reason||'The assertion needs clarification.',issues:verdict.missing,suggestion:verdict.suggestion??null})
}

export async function saveKnowledge(raw: unknown): Promise<unknown> {
  const input = parseKnowledge(KnowledgeWrite, raw)
  const request={operation:'create',input}
  const receipt=await existingReceipt(input.idempotencyKey,request)
  if(receipt)return receipt.response
  // Scan content AND metadata/evidence. Metadata is not a DLP escape hatch.
  await assertNoPii(JSON.stringify(input))
  await assertKnowledgeContent(input.content)
  return withReceipt(input.idempotencyKey, request, async tx => {
    const classification = await resolveClassification(tx, input.classification, input.resolutions)
    let row = await tx.memory.create({ data: { id: randomUUID(), teamId: getCtx().teamId!, createdById: getCtx().userId,
      content: input.content, ownershipState: 'personal', ...classificationData(classification), graphVersion: new Date(),
    } })
    await persistClaim(tx, row, classification)
    row = await tx.memory.findUniqueOrThrow({ where: { id: row.id } })
    await tx.memoryRevision.create({ data: { id: randomUUID(), teamId: row.teamId, memoryId: row.id, revision: row.revision,
      snapshot: json(row), intent: 'create', reason: 'Explicit classified capture.', evidence: json(classification.sources), actorId: getCtx().userId,
    } })
    return knowledgeResult(row)
  })
}

export async function updateKnowledge(memoryId: string, raw: unknown): Promise<unknown> {
  const input: ClassifiedUpdate = parseKnowledge(KnowledgeUpdate, raw)
  const request={operation:'update',memoryId,input}
  const receipt=await existingReceipt(input.idempotencyKey,request)
  if(receipt)return receipt.response
  const current=await runInTenant((tx:Tx)=>tx.memory.findUnique({where:{id:memoryId}}))
  if(!current)throw new KnowledgeError('not_found',404,'No authorized personal memory has this ID.')
  if(current.revision!==input.expectedRevision)throw new KnowledgeError('revision_conflict',409,'Read and reconcile the current accepted revision before retrying.')
  const candidate=KnowledgeWrite.safeParse({contractVersion:2,content:input.changes.content??current.content,classification:input.changes.classification??current.knowledge,idempotencyKey:input.idempotencyKey})
  if(!candidate.success)throw new KnowledgeError('memory_classification_invalid',422,'The resulting record must satisfy the complete current contract.',{issues:candidate.error.issues})
  await assertNoPii(JSON.stringify({input,resulting:candidate.data}))
  await assertKnowledgeContent(candidate.data.content)
  return withReceipt(input.idempotencyKey, request, async tx => {
    const prior = await tx.memory.findUnique({ where: { id: memoryId } })
    if (!prior) throw new KnowledgeError('not_found', 404, 'No authorized personal memory has this ID.')
    if (prior.revision !== input.expectedRevision) throw new KnowledgeError('revision_conflict', 409, 'Read the current record and reconcile your explicit changes before retrying.', { expectedRevision: input.expectedRevision, currentRevision: prior.revision, id: memoryId })
    const candidate = input.changes.classification ?? prior.knowledge
    const parsed = KnowledgeClassification.safeParse(candidate)
    if (!parsed.success) throw new KnowledgeError('legacy_classification_required', 422, 'Editing a legacy record requires its full explicit classification; historical evidence is not guessed.', { issues: parsed.error.issues })
    const resulting = KnowledgeWrite.safeParse({ contractVersion: 2, content: input.changes.content ?? prior.content, classification: parsed.data, idempotencyKey: input.idempotencyKey })
    if (!resulting.success) throw new KnowledgeError('memory_classification_invalid', 422, 'The resulting record must satisfy the complete current write contract.', { issues: resulting.error.issues })
    const classification = await resolveClassification(tx, parsed.data, input.resolutions)
    if (input.intent === 'additional_evidence' && input.changes.content && input.changes.content !== prior.content) throw new KnowledgeError('intent_conflict', 422, 'Additional evidence cannot replace the assertion content; use correction or supersession.')
    if (input.intent === 'reclassification' && input.changes.content && input.changes.content !== prior.content) throw new KnowledgeError('intent_conflict', 422, 'Reclassification changes classification only; use correction for content changes.')
    const priorHistory = await tx.memoryRevision.findUnique({ where: { memoryId_revision: { memoryId, revision: prior.revision } } })
    if (!priorHistory) await tx.memoryRevision.create({ data: { id: randomUUID(), teamId: prior.teamId, memoryId, revision: prior.revision, snapshot: json(prior), intent: 'legacy_snapshot', reason: 'Preserved before first classified update; no historical evidence inferred.', evidence: [], actorId: getCtx().userId } })
    const result = await tx.memory.updateMany({ where: { id: memoryId, revision: input.expectedRevision, deletedAt: null }, data: {
      content: input.changes.content ?? prior.content, ...classificationData(classification), revision: { increment: 1 },
      recordUpdatedAt: new Date(), embeddingStatus: 'pending', graphStatus: 'pending', graphVersion: new Date(), graphError: null,
    } })
    if (result.count !== 1) throw new KnowledgeError('revision_conflict', 409, 'The current revision changed; retrieve and reconcile before retrying.')
    let row = await tx.memory.findUniqueOrThrow({ where: { id: memoryId } })
    await persistClaim(tx, row, classification, prior.relationshipDependencies)
    row = await tx.memory.findUniqueOrThrow({ where: { id: memoryId } })
    await tx.memoryRevision.create({ data: { id: randomUUID(), teamId: row.teamId, memoryId, revision: row.revision, snapshot: json(row), intent: input.intent, reason: input.reason, evidence: json(input.evidence), actorId: getCtx().userId } })
    return knowledgeResult(row)
  })
}
