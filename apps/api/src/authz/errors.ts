/**
 * persistent-memory-api — typed authz errors (Phase 3).
 *
 * Thrown by the auth hook + guards, caught by the central error handler
 * (app.ts) and rendered as actionable JSON. Keeping them as classes (not inline
 * reply.send) lets guards be `throw`-style and keeps the status/shape in one
 * place. NEVER put the token (or any secret) in a message.
 */

/** 401 — authentication failed (no/invalid/expired/revoked token). */
export class AuthError extends Error {
  readonly statusCode = 401 as const
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/** 403 — authenticated but not permitted (deny-by-default authorization). */
export class ForbiddenError extends Error {
  readonly statusCode = 403 as const
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/**
 * 422 — the Shape A–E SEMANTIC write gate rejected the memory (Phase 7).
 *
 * Distinct from a Zod request-shape 400: this means "your JSON parsed, but the
 * memory failed the Shape gate — here are the rewrite templates + entity rules".
 * The MCP (P8) needs to tell these apart. `.payload` ports
 * MCPValidationError.payload from lib/validation.py and IS the 422 response body
 * (the central error handler in app.ts sends it verbatim), so an agent can
 * self-correct without fetching any server-side file. The constructor builds the
 * payload; do NOT put the token or any secret anywhere in it.
 */
export interface RejectPayload {
  error: 'validation_failed'
  reason: string
  missing: string[]
  rewrite_templates: Record<string, string>
  entity_format: unknown
  valid_categories: readonly string[]
  valid_sources: readonly string[]
  your_submission: {
    content_excerpt: string | null
    content_length: number
    metadata_received: unknown
  }
  suggestion?: string
}

export class ValidationError extends Error {
  readonly statusCode = 422 as const
  readonly code = 'validation_failed' as const
  readonly payload: RejectPayload

  constructor(payload: RejectPayload) {
    super(payload.reason)
    this.name = 'ValidationError'
    this.payload = payload
  }
}

/**
 * 422 — the DLP/PII write-gate blocked the memory (Phase 8, #10). Distinct from the
 * Shape `validation_failed` (different `error` code so the MCP can tell them apart):
 * the memory carried PII (Presidio) or a secret (gitleaks). The payload is
 * REDACTION-SAFE — it names the finding TYPES only, never the raw value. `.payload`
 * IS the 422 response body (the central handler sends it verbatim).
 */
export interface PiiPayload {
  error: 'pii_detected'
  reason: string
  /** Redaction-safe: detector + type + severity only. No raw secret/PII value. */
  findings: { detector: string; finding_type: string; severity: string }[]
  guidance: string
}

export class PiiDetectedError extends Error {
  readonly statusCode = 422 as const
  readonly code = 'pii_detected' as const
  readonly payload: PiiPayload

  constructor(payload: PiiPayload) {
    super(payload.reason)
    this.name = 'PiiDetectedError'
    this.payload = payload
  }
}

export const unauthorized = (
  message = 'Authentication required — send Authorization: Bearer <tokenId>.<secret>.',
  code = 'unauthorized',
): AuthError => new AuthError(code, message)

export const forbidden = (code: string, message: string): ForbiddenError =>
  new ForbiddenError(code, message)
