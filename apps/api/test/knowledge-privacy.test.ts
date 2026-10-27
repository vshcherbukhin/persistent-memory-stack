import { describe, expect, it } from 'vitest'
import { knowledgePrivacyView } from '../src/protocol/knowledge-privacy.ts'

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
