/**
 * Phase 11 document-lifecycle decision — the pure branch selector + content hash.
 * (The impure helpers read/write Postgres + Qdrant and are covered by the live
 * integration suite; this pins the dedup/version LOGIC deterministically.)
 */
import { describe, it, expect } from 'vitest'
import { decideIngestAction, hashText } from '../src/steps/document-version.ts'

describe('decideIngestAction', () => {
  it('first ingest (no prior hash) → "first"', () => {
    expect(decideIngestAction(null, 'abc')).toBe('first')
    expect(decideIngestAction(undefined, 'abc')).toBe('first')
    expect(decideIngestAction('', 'abc')).toBe('first') // empty == not-yet-hashed
  })
  it('re-ingest with the SAME content → "unchanged" (pure dedup)', () => {
    expect(decideIngestAction('abc', 'abc')).toBe('unchanged')
  })
  it('re-ingest with CHANGED content → "changed" (new version)', () => {
    expect(decideIngestAction('abc', 'xyz')).toBe('changed')
  })
})

describe('hashText', () => {
  it('is deterministic + sensitive to content', () => {
    expect(hashText('hello world')).toBe(hashText('hello world'))
    expect(hashText('hello world')).not.toBe(hashText('hello world!'))
    expect(hashText('x')).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
  })
})
