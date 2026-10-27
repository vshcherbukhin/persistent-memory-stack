/** Community knowledge contract v2. Identity, revisions and processing state are server-owned. */
import { z } from 'zod'

export const KNOWLEDGE_CONTRACT_VERSION = 2 as const
export const MEMORY_TYPES = ['fact', 'decision', 'preference', 'procedure', 'event', 'constraint'] as const
export const ASSERTION_STATUSES = ['fact', 'observation', 'proposal', 'inference'] as const
export const UPDATE_INTENTS = ['correction', 'supersession', 'additional_evidence', 'reclassification'] as const
export const RELATION_TYPES = ['ABOUT', 'USES', 'EVALUATES', 'PREFERS', 'SUPPORTED_BY', 'SUPERSEDES'] as const
const name = z.string().trim().min(1).max(120)
const slug = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Use a normalized lowercase topic slug, for example memory-retrieval.').max(80)
const uniqueNames = z.array(name).max(20).refine(values => new Set(values).size === values.length, 'Remove duplicate associations.')

export const KnowledgeSource = z.object({
  kind: z.enum(['user', 'document', 'tool', 'web', 'agent', 'import']),
  reference: z.string().trim().min(3).max(2000),
  evidence: z.string().trim().min(8).max(8000),
}).strict()

export const KnowledgeClassification = z.object({
  memoryType: z.enum(MEMORY_TYPES),
  assertionStatus: z.enum(ASSERTION_STATUSES),
  primaryTopic: slug,
  topicTags: z.array(slug).min(1).max(12),
  origin: z.object({ kind: z.enum(['general', 'system', 'project']), name: name.optional() }).strict(),
  applicability: z.object({
    state: z.enum(['associated', 'general', 'unresolved']),
    projects: uniqueNames.optional(),
    systems: uniqueNames.optional(),
    reason: z.string().trim().min(8).max(2000).optional(),
  }).strict(),
  sources: z.array(KnowledgeSource).min(1).max(20),
  entities: z.array(z.string().regex(/^[a-z][a-z0-9]*_[a-z0-9_]+$/)).max(20).optional(),
  additionalTags: z.array(slug).max(20).optional(),
  title: z.string().trim().min(3).max(200).optional(),
  relationships: z.array(z.object({
    type: z.enum(RELATION_TYPES),
    target: z.object({ kind: z.enum(['memory', 'topic', 'project', 'system', 'entity']), name }).strict(),
    status: z.enum(['proposed', 'inferred', 'source_supported']),
    sourceReferences: z.array(z.string().min(3).max(2000)).min(1).max(20),
  }).strict()).max(12).optional(),
}).strict().superRefine((value, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message })
  if (!value.topicTags.includes(value.primaryTopic)) issue(['topicTags'], 'Include primaryTopic in topicTags.')
  if (new Set(value.topicTags).size !== value.topicTags.length) issue(['topicTags'], 'Remove duplicate topics.')
  if (value.origin.kind === 'general' && value.origin.name) issue(['origin', 'name'], 'General origin has no project/system name.')
  if (value.origin.kind !== 'general' && !value.origin.name) issue(['origin', 'name'], 'Name the origin project or system explicitly.')
  const associations = [...value.applicability.projects ?? [], ...value.applicability.systems ?? []]
  if (value.applicability.state === 'associated' && associations.length === 0) issue(['applicability'], 'Associated applicability requires a project or system.')
  if (value.applicability.state !== 'associated' && associations.length) issue(['applicability'], 'General/unresolved applicability cannot claim validated associations.')
  if (value.applicability.state === 'unresolved' && !value.applicability.reason) issue(['applicability', 'reason'], 'Explain what remains unresolved.')
  if (value.applicability.state === 'unresolved' && value.assertionStatus === 'fact') issue(['assertionStatus'], 'Unresolved applicability cannot be stored as a validated fact; use observation, proposal or inference.')
  for (const [index, relationship] of (value.relationships ?? []).entries()) {
    if (!relationship.sourceReferences.every(reference => value.sources.some(source => source.reference === reference))) issue(['relationships', index, 'sourceReferences'], 'Relationship evidence must reference this record sources.')
    if (value.assertionStatus === 'proposal' && relationship.status === 'source_supported') issue(['relationships', index, 'status'], 'A proposal cannot silently establish a supported relationship; use proposed.')
  }
})

export const KnowledgeResolution = z.object({
  kind: z.enum(['topic', 'project', 'system']), name, action: z.literal('create'),
  reason: z.string().trim().min(8).max(1000),
}).strict()
export const KnowledgeWrite = z.object({
  contractVersion: z.literal(KNOWLEDGE_CONTRACT_VERSION),
  content: z.string().trim().min(40).max(64000),
  classification: KnowledgeClassification,
  idempotencyKey: z.string().min(8).max(160),
  resolutions: z.array(KnowledgeResolution).max(8).optional(),
}).strict()
export const KnowledgeChanges = z.object({
  content: z.string().trim().min(40).max(64000).optional(),
  classification: KnowledgeClassification.optional(),
}).strict().refine(value => value.content !== undefined || value.classification !== undefined, 'Supply explicit changes.')
export const KnowledgeUpdate = z.object({
  contractVersion: z.literal(KNOWLEDGE_CONTRACT_VERSION),
  expectedRevision: z.number().int().positive(),
  intent: z.enum(UPDATE_INTENTS), changes: KnowledgeChanges,
  reason: z.string().trim().min(8).max(2000),
  evidence: z.array(KnowledgeSource).min(1).max(20),
  idempotencyKey: z.string().min(8).max(160),
  resolutions: z.array(KnowledgeResolution).max(8).optional(),
}).strict()
export const KnowledgeFilters = z.object({
  project: name.optional(), projects: uniqueNames.optional(), topic: slug.optional(),
  memoryType: z.enum([...MEMORY_TYPES, 'legacy_unclassified']).optional(),
  assertionStatus: z.enum([...ASSERTION_STATUSES, 'legacy_unclassified']).optional(),
  createdAfter: z.string().datetime().optional(), createdBefore: z.string().datetime().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.project && value.projects) ctx.addIssue({ code: 'custom', path: ['projects'], message: 'Use project or projects, not both.' })
  if (value.projects?.length === 0) ctx.addIssue({ code: 'custom', path: ['projects'], message: 'Explicit projects must not be empty.' })
  if (value.createdAfter && value.createdBefore && value.createdAfter > value.createdBefore) ctx.addIssue({ code: 'custom', path: ['createdBefore'], message: 'Time range ends before it starts.' })
})
export type Classification = z.infer<typeof KnowledgeClassification>
export type ClassifiedWrite = z.infer<typeof KnowledgeWrite>
export type ClassifiedUpdate = z.infer<typeof KnowledgeUpdate>
export type KnowledgeFilter = z.infer<typeof KnowledgeFilters>

export const KNOWLEDGE_UPGRADE_GUIDANCE = 'Community memory contract v2 requires classification, explicit origin/applicability, source evidence and an idempotencyKey. Discover memory_catalog, then retry with contractVersion:2. Updates also require expectedRevision, intent, explicit changes, reason and evidence. Legacy records remain readable; legacy writes cannot guess required metadata.'
