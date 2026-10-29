import { describe, expect, it } from 'vitest'
import { classificationDraft, classificationFromDraft, operationKey, type Classification } from './knowledge'

const classified: Classification = {
  memoryType: 'decision', assertionStatus: 'proposal', primaryTopic: 'memory-retrieval', topicTags: ['memory-retrieval'],
  origin: { kind: 'project', name: 'project-a' }, applicability: { state: 'associated', projects: ['project-a', 'project-b'] },
  sources: [{ kind: 'user', reference: 'conversation:synthetic', evidence: 'Owner proposed an evaluation; no adoption decision was made.' }],
}

describe('classified dashboard drafts', () => {
  it('leaves unclassified legacy certainty and scope unresolved for the user to supply', () => {
    const draft = classificationDraft(null)
    expect(draft.assertionStatus).toBe('')
    expect(draft.originKind).toBe('')
    expect(draft.applicabilityState).toBe('')
    expect(() => classificationFromDraft(draft)).toThrow('Choose a memory type')
  })
  it('retains a proposal and multiple project associations without copying the claim', () => {
    expect(classificationFromDraft(classificationDraft(classified))).toEqual(classified)
  })
  it('preserves existing typed relationships and their source support through unrelated edits', () => {
    const value: Classification = { ...classified, relationships: [{ type: 'EVALUATES', target: { kind: 'project', name: 'project-b' }, status: 'proposed', sourceReferences: ['conversation:synthetic'] }] }
    expect(classificationFromDraft(classificationDraft(value))).toEqual(value)
  })
  it('rejects contradictory general applicability and a validated fact with unresolved scope', () => {
    const draft = classificationDraft(classified)
    expect(() => classificationFromDraft({ ...draft, applicabilityState: 'general' })).toThrow('cannot include validated associations')
    expect(() => classificationFromDraft({ ...draft, projects: '', applicabilityState: 'unresolved', assertionStatus: 'fact', applicabilityReason: 'Applicability needs owner review.' })).toThrow('observation, proposal or inference')
  })
  it('requires a meaningful source reference/evidence and primary-topic membership', () => {
    const draft = classificationDraft(classified)
    expect(() => classificationFromDraft({ ...draft, topicTags: 'unrelated-topic' })).toThrow('include the primary topic')
    expect(() => classificationFromDraft({ ...draft, sources: [{ kind: 'agent', reference: '', evidence: '' }] })).toThrow('reference and evidence')
  })
  it('reuses an idempotency key for retries and changes it when content or revision changes', () => {
    const first = operationKey(null, { expectedRevision: 3, content: 'one' }, () => 'first-key')
    expect(operationKey(first, { expectedRevision: 3, content: 'one' }, () => 'unused-key')).toBe(first)
    expect(operationKey(first, { expectedRevision: 4, content: 'one' }, () => 'new-key').key).toBe('new-key')
    expect(operationKey(first, { expectedRevision: 3, content: 'two' }, () => 'changed-key').key).toBe('changed-key')
  })
})
