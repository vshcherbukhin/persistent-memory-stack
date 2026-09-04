/**
 * @pm/security-dlp — client + gate for the DLP sidecar.
 *
 * Prisma-free, shared by the api (memory write-gate) and the worker (document-ingest
 * block + the pii-scan job). The sidecar (dlp-service) wraps the OFFICIAL Presidio
 * analyzer + gitleaks; this is the thin HTTP client + the FAIL-CLOSED gate decision.
 *
 * FAIL-CLOSED is the whole point: if the sidecar is unreachable, times out, or errors
 * (e.g. gitleaks broke), dlpGate() returns { blocked: true } with a synthetic
 * `scanner_unavailable` finding — the caller blocks the write rather than letting
 * unscanned content through. The decision logic is pure (mock the client) so it is
 * unit-tested without a network.
 */

export interface PiiFinding {
  entity_type: string
  start: number
  end: number
  score: number
}
export interface SecretFinding {
  rule_id: string
  description: string
}
export interface ScanResult {
  pii: PiiFinding[]
  secrets: SecretFinding[]
  block: boolean
}

export class DlpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DlpError'
  }
}

export interface DlpScanOpts {
  /** Restrict PII detection to these entity types (the deny-list). */
  entities?: readonly string[]
  scoreThreshold?: number
}

export interface DlpClient {
  scan(text: string, opts?: DlpScanOpts): Promise<ScanResult>
}

/**
 * The default PII deny-list: STRUCTURED PII only. Deliberately excludes the noisy
 * NER entities (PERSON / LOCATION / DATE_TIME) that would block legitimate writes
 * merely mentioning a name or date. Override via the PII_ENTITIES env var.
 */
export const DEFAULT_PII_ENTITIES = [
  'US_SSN',
  'CREDIT_CARD',
  'EMAIL_ADDRESS',
  'IBAN_CODE',
  'CRYPTO',
  'PHONE_NUMBER',
  'IP_ADDRESS',
  'US_PASSPORT',
  'US_ITIN',
] as const

/** Parse a comma-separated PII_ENTITIES env value → the deny-list (or the default). */
export function resolvePiiEntities(envValue: string | undefined): readonly string[] {
  const parsed = (envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parsed.length > 0 ? parsed : DEFAULT_PII_ENTITIES
}

export function makeDlpClient(opts: { baseUrl: string; timeoutMs?: number }): DlpClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? 4000
  return {
    async scan(text, o) {
      let res: Response
      try {
        res = await fetch(`${baseUrl}/scan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            entities: o?.entities ? [...o.entities] : undefined,
            score_threshold: o?.scoreThreshold,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        throw new DlpError(`dlp sidecar unreachable: ${String(err)}`)
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new DlpError(`dlp scan failed (${res.status}): ${body.slice(0, 300)}`)
      }
      return (await res.json()) as ScanResult
    },
  }
}

export type Detector = 'presidio' | 'gitleaks' | 'dlp'
export type Severity = 'low' | 'medium' | 'high'

/** A normalized, REDACTION-SAFE finding (never carries the raw secret/PII value). */
export interface GateFinding {
  detector: Detector
  findingType: string
  severity: Severity
  redactedExcerpt: string
}

export interface GateResult {
  blocked: boolean
  findings: GateFinding[]
  /** true when the block is because the scanner itself failed (fail-closed). */
  failClosed: boolean
}

/**
 * Run the DLP scan and decide. FAIL-CLOSED: a scanner error/timeout/unreachable →
 * blocked with a `scanner_unavailable` finding. Otherwise blocked iff any PII (already
 * filtered to `entities`) or secret was found. Findings are redaction-safe: PII is
 * recorded as `TYPE@start-end` (no value); secrets as the rule + description.
 */
export async function dlpGate(
  client: DlpClient,
  text: string,
  opts: DlpScanOpts = {},
): Promise<GateResult> {
  let scan: ScanResult
  try {
    scan = await client.scan(text, opts)
  } catch {
    return {
      blocked: true,
      failClosed: true,
      findings: [
        { detector: 'dlp', findingType: 'scanner_unavailable', severity: 'high', redactedExcerpt: 'DLP scanner unavailable — write blocked (fail-closed)' },
      ],
    }
  }
  const findings: GateFinding[] = [
    ...scan.pii.map(
      (p): GateFinding => ({
        detector: 'presidio',
        findingType: p.entity_type,
        severity: 'high',
        redactedExcerpt: `${p.entity_type}@${p.start}-${p.end}`,
      }),
    ),
    ...scan.secrets.map(
      (s): GateFinding => ({
        detector: 'gitleaks',
        findingType: s.rule_id,
        severity: 'high',
        redactedExcerpt: s.description || s.rule_id,
      }),
    ),
  ]
  return { blocked: findings.length > 0, findings, failClosed: false }
}
