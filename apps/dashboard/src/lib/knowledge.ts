/** HTTP contract mirror for the standalone dashboard; the API remains authoritative. */
export type MemoryType = 'fact' | 'decision' | 'preference' | 'procedure' | 'event' | 'constraint'
export type AssertionStatus = 'fact' | 'observation' | 'proposal' | 'inference'
export type UpdateIntent = 'correction' | 'supersession' | 'additional_evidence' | 'reclassification'
export interface KnowledgeSource { kind: 'user' | 'document' | 'tool' | 'web' | 'agent' | 'import'; reference: string; evidence: string }
export interface Classification {
  memoryType: MemoryType
  assertionStatus: AssertionStatus
  primaryTopic: string
  topicTags: string[]
  origin: { kind: 'general' | 'system' | 'project'; name?: string }
  applicability: { state: 'associated' | 'general' | 'unresolved'; projects?: string[]; systems?: string[]; reason?: string }
  sources: KnowledgeSource[]
  entities?: string[]
  additionalTags?: string[]
  title?: string
  relationships?: {
    type: 'ABOUT' | 'USES' | 'EVALUATES' | 'PREFERS' | 'SUPPORTED_BY' | 'SUPERSEDES'
    target: { kind: 'memory' | 'topic' | 'project' | 'system' | 'entity'; name: string }
    status: 'proposed' | 'inferred' | 'source_supported'
    sourceReferences: string[]
  }[]
}
export interface KnowledgeResolution { kind: 'topic' | 'project' | 'system'; name: string; action: 'create'; reason: string }
export interface ClassifiedWrite { contractVersion: 2; content: string; classification: Classification; idempotencyKey: string; resolutions?: KnowledgeResolution[] }
export interface ClassifiedUpdate {
  contractVersion: 2; expectedRevision: number; intent: UpdateIntent
  changes: { content?: string; classification?: Classification }
  reason: string; evidence: KnowledgeSource[]; idempotencyKey: string; resolutions?: KnowledgeResolution[]
}
export interface KnowledgeCatalog {
  contractVersion: 2
  classifications: { kind: 'topic' | 'project' | 'system'; name: string; aliases: string[] }[]
  nextCursor: string | null
  filters: Record<string, string>
}
export interface ClassificationDraft {
  memoryType: MemoryType | ''; assertionStatus: AssertionStatus | ''
  primaryTopic: string; topicTags: string; originKind: Classification['origin']['kind'] | ''; originName: string
  applicabilityState: Classification['applicability']['state'] | ''; projects: string; systems: string; applicabilityReason: string
  sources: KnowledgeSource[]; entities: string; additionalTags: string; title: string
  relationships: NonNullable<Classification['relationships']>
}
export const commaNames = (text: string): string[] => text.split(',').map(value => value.trim()).filter(Boolean)
export function classificationDraft(value?: Classification | null): ClassificationDraft {
  return {
    memoryType: value?.memoryType ?? '', assertionStatus: value?.assertionStatus ?? '',
    primaryTopic: value?.primaryTopic ?? '', topicTags: value?.topicTags.join(', ') ?? '',
    originKind: value?.origin.kind ?? '', originName: value?.origin.name ?? '',
    applicabilityState: value?.applicability.state ?? '', projects: value?.applicability.projects?.join(', ') ?? '',
    systems: value?.applicability.systems?.join(', ') ?? '', applicabilityReason: value?.applicability.reason ?? '',
    sources: value?.sources.map(source => ({ ...source })) ?? [{ kind: 'user', reference: '', evidence: '' }],
    entities: value?.entities?.join(', ') ?? '', additionalTags: value?.additionalTags?.join(', ') ?? '', title: value?.title ?? '',
    relationships: value?.relationships?.map(item => ({ ...item, target: { ...item.target }, sourceReferences: [...item.sourceReferences] })) ?? [],
  }
}
/** No inferred origin, applicability or certainty is supplied for legacy records. */
export function classificationFromDraft(draft: ClassificationDraft): Classification {
  if (!draft.memoryType || !draft.assertionStatus || !draft.originKind || !draft.applicabilityState) throw new Error('Choose a memory type, assertion status, origin and applicability.')
  const topicTags = commaNames(draft.topicTags)
  const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
  if (!slug.test(draft.primaryTopic) || topicTags.some(value => !slug.test(value)) || !topicTags.includes(draft.primaryTopic)) throw new Error('Use normalized topic tags and include the primary topic among them.')
  if (new Set(topicTags).size !== topicTags.length) throw new Error('Remove duplicate topic tags.')
  if (draft.originKind !== 'general' && !draft.originName.trim()) throw new Error('Name the origin project or system.')
  const projects = commaNames(draft.projects); const systems = commaNames(draft.systems)
  if (draft.applicabilityState === 'associated' && !projects.length && !systems.length) throw new Error('Name at least one applicable project or system.')
  if (draft.applicabilityState !== 'associated' && (projects.length || systems.length)) throw new Error('General or unresolved applicability cannot include validated associations.')
  if (draft.applicabilityState === 'unresolved' && (draft.applicabilityReason.trim().length < 8 || draft.assertionStatus === 'fact')) throw new Error('Explain unresolved applicability and choose observation, proposal or inference.')
  if (!draft.sources.length || draft.sources.some(source => source.reference.trim().length < 3 || source.evidence.trim().length < 8)) throw new Error('Each source needs a reference and evidence sufficient to understand the assertion.')
  return {
    memoryType: draft.memoryType, assertionStatus: draft.assertionStatus, primaryTopic: draft.primaryTopic,
    topicTags, origin: { kind: draft.originKind, ...(draft.originKind !== 'general' ? { name: draft.originName.trim() } : {}) },
    applicability: { state: draft.applicabilityState, ...(projects.length ? { projects } : {}), ...(systems.length ? { systems } : {}), ...(draft.applicabilityReason.trim() ? { reason: draft.applicabilityReason.trim() } : {}) },
    sources: draft.sources.map(source => ({ kind: source.kind, reference: source.reference.trim(), evidence: source.evidence.trim() })),
    ...(draft.entities.trim() ? { entities: commaNames(draft.entities) } : {}),
    ...(draft.additionalTags.trim() ? { additionalTags: commaNames(draft.additionalTags) } : {}),
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    ...(draft.relationships.length ? { relationships: draft.relationships.map(item => ({ ...item, sourceReferences: item.sourceReferences.map(value => value.trim()).filter(Boolean) })) } : {}),
  }
}

/** Keep the key stable across retries, but never reuse it for changed operation bytes. */
export function operationKey(previous: { fingerprint: string; key: string } | null, payload: unknown, create: () => string) {
  const fingerprint = JSON.stringify(payload)
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: create() }
}
