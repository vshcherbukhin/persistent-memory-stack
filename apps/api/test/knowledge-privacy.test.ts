import { describe, expect, it } from 'vitest'
import { knowledgePrivacyView, archivePrivacyView } from '../src/protocol/knowledge-privacy.ts'

describe('knowledge privacy scan input', () => {
  it('keeps all UUID retry bytes and semantic fields without a credential assignment label', () => {
    const id = 'cd8b4071-e624-48d0-9561-0ca3effb01ee'
    const classification = { sources: [{ evidence: `The literal idempotencyKey is "${id}".`, reference: 'synthetic-source' }], relationships: [{ sourceReferences: ['synthetic-source'] }] }
    const resolutions = [{ kind: 'topic', name: 'synthetic-topic', reason: 'Explicit evidence for this topic.' }]
    const input = { content: 'The synthetic record preserves all evidence for privacy scanning.', classification, resolutions, idempotencyKey: id }
    const scanned = knowledgePrivacyView(input)
    expect(scanned).toEqual({ content: input.content, classification, resolutions, receiptId: id })
    expect(scanned.classification).toBe(classification)
    expect(scanned.resolutions).toBe(resolutions)
    expect(input.idempotencyKey).toBe(id)
    expect(input).not.toHaveProperty('receiptId')
  })

  it.each(['ordinary-retry-key', 'sk-proj-synthetic-provider-secret', 'api_key=synthetic-generic-secret', 'not-a-uuid-48d0-9561-0ca3effb01ee', 'cd8b4071-e624-08d0-9561-0ca3effb01ee', 'cd8b4071-e624-48d0-0561-0ca3effb01ee'])('retains scanner credential context for other retry values: %s', idempotencyKey => {
    const input = { content: 'Synthetic assertion.', idempotencyKey }
    expect(knowledgePrivacyView(input)).toBe(input)
  })

  it('preserves update reason/evidence and the complete resulting assertion', () => {
    const idempotencyKey = 'cd8b4071-e624-48d0-9561-0ca3effb01ee'
    const input = { idempotencyKey, expectedRevision: 1, changes: { content: 'A corrected synthetic assertion.' }, reason: 'Explicit source correction.', evidence: [{ reference: 'synthetic-source', evidence: 'The source supplied this correction.' }] }
    const resulting = { idempotencyKey, content: input.changes.content, classification: { sources: input.evidence } }
    const scan = { input: knowledgePrivacyView(input), resulting: knowledgePrivacyView(resulting) }
    expect(scan.input).toMatchObject({ expectedRevision: 1, changes: input.changes, reason: input.reason, evidence: input.evidence, receiptId: idempotencyKey })
    expect(scan.resulting).toEqual({ content: resulting.content, classification: resulting.classification, receiptId: idempotencyKey })
    expect(input.idempotencyKey).toBe(resulting.idempotencyKey)
  })
})

describe('archive privacy scan input', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  it('neutralizes only three matching storage identity paths, without changing the authenticated archive', () => {
    const metadata = { id, note: `Semantic UUID literal: ${id}` }
    const history = { id: 'other-history-id', memoryId: id, actorId: id, evidence: { id }, reason: id, snapshot: { id, content: id, metadata } }
    const input = { id, createdById: id, archiveSignature: 'a'.repeat(64), content: id, metadata, classification: { sources: [{ evidence: id, reference: id }] }, catalog: [{ name: id }], revisionHistory: [history] }
    const original = JSON.stringify(input)
    const scanned = archivePrivacyView(input)
    expect(scanned.id).toBe('[validated memory identifier]')
    expect(scanned.revisionHistory[0]).toEqual({ ...history, memoryId: scanned.id, snapshot: { ...history.snapshot, id: scanned.id } })
    expect(scanned.metadata).toBe(metadata)
    expect(scanned.content).toBe(id)
    expect(scanned.classification).toBe(input.classification)
    expect(scanned.createdById).toBe(id)
    expect(scanned.catalog).toBe(input.catalog)
    expect(scanned.archiveSignature).toBe(input.archiveSignature)
    expect(JSON.stringify(input)).toBe(original)
  })
  it('retains mismatched history identities and unrelated nested fields for scanning', () => {
    const other = '22222222-2222-4222-8222-222222222222'
    const version = { memoryId: other, snapshot: { id: other, nested: { id } } }
    expect(archivePrivacyView({ id, revisionHistory: [version] }).revisionHistory[0]).toEqual(version)
  })
  it.each(['not-a-uuid', '11111111-1111-0111-8111-111111111111', '11111111-1111-4111-0111-111111111111'])('retains non-v4 or invalid root identifiers: %s', value => {
    const input = { id: value, revisionHistory: [{ memoryId: value, snapshot: { id: value } }] }
    expect(archivePrivacyView(input)).toBe(input)
  })
})
