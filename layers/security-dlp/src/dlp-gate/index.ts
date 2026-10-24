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

export type DlpFailureKind = 'timeout' | 'network' | 'http' | 'invalid_response'

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])

/** Diagnostics are built from controlled values, never scanner bodies or submitted content. */
export class DlpError extends Error {
  constructor(
    readonly kind: DlpFailureKind,
    readonly info: { timeoutMs?: number; status?: number; code?: string; attempts?: number } = {},
  ) {
    const code = info.code && NETWORK_CODES.has(info.code) ? info.code : undefined
    const detail = kind === 'timeout' ? `timed out after ${info.timeoutMs} ms per attempt`
      : kind === 'http' ? `returned HTTP ${info.status}`
        : kind === 'invalid_response' ? 'returned an invalid scan response'
          : `could not be reached${code ? ` (${code})` : ' (network error)'}`
    super(`The DLP scanner ${detail}${(info.attempts ?? 1) > 1 ? ` after ${info.attempts} attempts` : ''}.`)
    this.name = 'DlpError'
  }

  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'network'
      || (this.kind === 'http' && (this.info.status === 408 || this.info.status === 429 || (this.info.status ?? 0) >= 500))
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

function isScanResult(value: unknown): value is ScanResult {
  if (!value || typeof value !== 'object') return false
  const scan = value as ScanResult
  return Array.isArray(scan.pii) && Array.isArray(scan.secrets) && typeof scan.block === 'boolean'
    && scan.pii.every(p => p && typeof p.entity_type === 'string' && Number.isFinite(p.start) && Number.isFinite(p.end) && Number.isFinite(p.score))
    && scan.secrets.every(s => s && typeof s.rule_id === 'string' && typeof s.description === 'string')
    && scan.block === (scan.pii.length > 0 || scan.secrets.length > 0)
}

export function makeDlpClient(opts: { baseUrl: string; timeoutMs?: number; retryDelayMs?: number }): DlpClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? 4000
  return {
    async scan(text, o) {
      // Scanning has no write side effects. Retry one transient failure, before the
      // caller can write anything; never retry a successful PII/secret decision.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let failure: DlpError
        const signal = AbortSignal.timeout(timeoutMs)
        try {
          const res = await fetch(`${baseUrl}/scan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              entities: o?.entities ? [...o.entities] : undefined,
              score_threshold: o?.scoreThreshold,
            }),
            signal,
          })
          if (!res.ok) {
            await res.body?.cancel().catch(() => {})
            throw new DlpError('http', { status: res.status })
          }
          let scan: unknown
          try { scan = await res.json() } catch (error) {
            if (error instanceof SyntaxError) throw new DlpError('invalid_response')
            throw error
          }
          if (!isScanResult(scan)) throw new DlpError('invalid_response')
          return scan
        } catch (error) {
          if (error instanceof DlpError) failure = error
          else if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
            failure = new DlpError('timeout', { timeoutMs })
          } else {
            const cause = error instanceof Error ? error.cause : undefined
            const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
            failure = new DlpError('network', { code })
          }
        }
        if (!failure.retryable || attempt === 2) throw new DlpError(failure.kind, { ...failure.info, attempts: attempt })
        await new Promise(resolve => setTimeout(resolve, opts.retryDelayMs ?? 250))
      }
      throw new DlpError('network') // the bounded loop always returns or throws
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
  /** Controlled operational diagnostic; never raw scanner output or memory content. */
  failure?: { kind: DlpFailureKind; message: string }
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
  } catch (error) {
    return {
      blocked: true,
      failClosed: true,
      ...(error instanceof DlpError ? { failure: { kind: error.kind, message: error.message } } : {}),
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
  return { blocked: scan.block || findings.length > 0, findings, failClosed: false }
}
