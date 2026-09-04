/**
 * Unit: dlpGate + resolvePiiEntities — the pure DLP decision (Phase 8, #10).
 *
 * dlpGate wraps a DlpClient: it maps the sidecar's PII/secret findings to
 * redaction-safe GateFindings and decides `blocked`. The load-bearing property is
 * FAIL-CLOSED: a client that throws (sidecar down/timeout/error) → blocked:true with
 * a scanner_unavailable finding, NEVER a silent allow. The real HTTP call is
 * effectful (covered live); this isolates the mapping + the fail-closed branch.
 */
import { describe, it, expect } from 'vitest'
import { dlpGate, resolvePiiEntities, DEFAULT_PII_ENTITIES, type DlpClient, type ScanResult } from '../../../layers/security-dlp/src/index.ts'

const clientReturning = (r: ScanResult): DlpClient => ({ scan: async () => r })
const clientThrowing = (): DlpClient => ({ scan: async () => { throw new Error('ECONNREFUSED') } })

describe('dlpGate', () => {
  it('does not block clean content', async () => {
    const r = await dlpGate(clientReturning({ pii: [], secrets: [], block: false }), 'all good')
    expect(r.blocked).toBe(false)
    expect(r.failClosed).toBe(false)
    expect(r.findings).toEqual([])
  })

  it('blocks on PII and records a redaction-safe finding (TYPE@start-end, no value)', async () => {
    const r = await dlpGate(
      clientReturning({ pii: [{ entity_type: 'US_SSN', start: 49, end: 60, score: 0.85 }], secrets: [], block: true }),
      'ssn here',
    )
    expect(r.blocked).toBe(true)
    expect(r.failClosed).toBe(false)
    expect(r.findings).toEqual([
      { detector: 'presidio', findingType: 'US_SSN', severity: 'high', redactedExcerpt: 'US_SSN@49-60' },
    ])
    // The raw value must never appear in a finding.
    expect(JSON.stringify(r.findings)).not.toContain('ssn here')
  })

  it('blocks on a secret (gitleaks) using rule + description, not the secret', async () => {
    const r = await dlpGate(
      clientReturning({ pii: [], secrets: [{ rule_id: 'aws-access-token', description: 'AWS Access Token' }], block: true }),
      'AKIA...',
    )
    expect(r.blocked).toBe(true)
    expect(r.findings).toEqual([
      { detector: 'gitleaks', findingType: 'aws-access-token', severity: 'high', redactedExcerpt: 'AWS Access Token' },
    ])
  })

  it('FAILS CLOSED: a scanner error blocks with a scanner_unavailable finding', async () => {
    const r = await dlpGate(clientThrowing(), 'whatever')
    expect(r.blocked).toBe(true)
    expect(r.failClosed).toBe(true)
    expect(r.findings[0].findingType).toBe('scanner_unavailable')
  })
})

describe('resolvePiiEntities', () => {
  it('empty/undefined → the structured-PII default (no noisy PERSON/LOCATION)', () => {
    expect(resolvePiiEntities('')).toBe(DEFAULT_PII_ENTITIES)
    expect(resolvePiiEntities(undefined)).toBe(DEFAULT_PII_ENTITIES)
    expect(DEFAULT_PII_ENTITIES).not.toContain('PERSON')
    expect(DEFAULT_PII_ENTITIES).not.toContain('LOCATION')
  })
  it('parses a comma-separated override (trims, drops empties)', () => {
    expect(resolvePiiEntities('US_SSN, EMAIL_ADDRESS ,, CRYPTO')).toEqual(['US_SSN', 'EMAIL_ADDRESS', 'CRYPTO'])
  })
})
