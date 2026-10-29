/** v2 writes require explicit origin/applicability; project metadata never grants ownership. */
import { describe, expect, it } from 'vitest'
import { KnowledgeWrite, KnowledgeUpdate } from '@pm/shared'
import { parseKnowledge } from '../src/services/knowledge.ts'

const write = { contractVersion: 2, content: 'The synthetic owner proposed an evaluation without accepting an adoption decision.', classification: {
  memoryType: 'decision', assertionStatus: 'proposal', primaryTopic: 'memory-retrieval', topicTags: ['memory-retrieval'],
  origin: { kind: 'project', name: 'alpha' }, applicability: { state: 'associated', projects: ['alpha', 'beta'] },
  sources: [{ kind: 'user', reference: 'conversation:fixture', evidence: 'The owner proposed evaluation; adoption remains undecided.' }],
}, idempotencyKey: 'fixture-explicit-origin' }

describe('classified memory origin contract', () => {
  it('requires origin rather than silently defaulting to general', () => {
    const { origin: _origin, ...classification } = write.classification
    expect(KnowledgeWrite.safeParse({ ...write, classification }).success).toBe(false)
  })
  it('preserves explicit origin and multiple project associations without copying content', () => {
    expect(KnowledgeWrite.parse(write)).toEqual(write)
  })
  it('supports an explicitly general conversation without inventing a project', () => {
    const input = { ...write, classification: { ...write.classification, origin: { kind: 'general' }, applicability: { state: 'general' } } }
    expect(KnowledgeWrite.parse(input).classification.origin).toEqual({ kind: 'general' })
  })
  it('rejects empty origins and associations that do not support their state', () => {
    expect(KnowledgeWrite.safeParse({ ...write, classification: { ...write.classification, origin: { kind: 'project', name: '' } } }).success).toBe(false)
    expect(KnowledgeWrite.safeParse({ ...write, classification: { ...write.classification, applicability: { state: 'associated' } } }).success).toBe(false)
  })
  it('rejects caller-owned identity/timestamps and legacy top-level project fields', () => {
    for (const forged of [{ teamId: 'foreign' }, { userId: 'owner' }, { revision: 9 }, { createdAt: new Date().toISOString() }, { project: 'alpha' }]) expect(KnowledgeWrite.safeParse({ ...write, ...forged }).success).toBe(false)
  })
  it('returns actionable version upgrade errors and rejects an update without an expected revision', () => {
    expect(() => parseKnowledge(KnowledgeWrite, { content: write.content, project: 'alpha' })).toThrow('Community memory contract v2')
    expect(KnowledgeUpdate.safeParse({ contractVersion: 2, changes: { content: write.content }, intent: 'correction', reason: 'Owner supplied a correction.', evidence: write.classification.sources, idempotencyKey: 'fixture-update-key' }).success).toBe(false)
  })
})
