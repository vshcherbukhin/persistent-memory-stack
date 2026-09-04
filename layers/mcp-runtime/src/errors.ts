/**
 * ApiError — the single place every persistent-memory-api HTTP failure becomes
 * an ACTIONABLE agent-facing message.
 *
 * Tool handlers catch ApiError and return `{ content:[{type:'text', text}],
 * isError:true, structuredContent? }` (NOT a throw) so the agent SEES the
 * guidance and can self-correct in the same turn. The 422 path is special: it
 * carries the WHOLE RejectPayload from the API verbatim (rewrite_templates +
 * entity_format + valid_categories/valid_sources + your_submission), which is
 * the agent's tutor for the Shape A–E write gate. Never auto-retry a 422.
 *
 * The API error contract (from api/src/app.ts setErrorHandler + authz/errors.ts):
 *   401 {error,message}                 — AuthError (invalid/expired/revoked token)
 *   403 {error,message}                 — ForbiddenError (write_denied | scope_not_readable | …)
 *   422 RejectPayload                   — the Shape-gate semantic reject (full payload)
 *   422 {error:'vector_dim_mismatch' | 'embedding_pin_mismatch', message}
 *   400 {error:'validation_error', issues}   — Zod request-shape reject
 *   400 {error:'query_required' | 'query_vector_required' | 'no_file', message}
 *   404 {error:'not_found' | 'target_not_found'}
 *   413 {error:'file_too_large', message}
 *   502 {error,message}                 — GraphitiError (graph backend down)
 *   503 {error:'extraction_provider_*', message} — fact extraction provider transient
 *   500 {error:'internal_error', message}
 */
import { redactToken } from './log.ts'

/** The 422 Shape-gate body the API returns verbatim (api/src/authz/errors.ts). */
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

/** The 422 DLP/PII body the API returns verbatim (api/src/authz/errors.ts). */
export interface PiiPayload {
  error: 'pii_detected'
  reason: string
  findings: { detector: string; finding_type: string; severity: string }[]
  guidance: string
}

type Json = Record<string, unknown> | undefined

/** Render Zod-style validation issues without echoing request values or a raw JSON blob. */
function validationIssueSummary(issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) return 'the API did not provide field details'
  const rendered = issues.slice(0, 4).map((issue) => {
    if (!issue || typeof issue !== 'object') return 'request: invalid value'
    const value = issue as Record<string, unknown>
    const path = Array.isArray(value.path)
      ? value.path.map((part) => String(part)).join('.') || 'request'
      : 'request'
    const message = typeof value.message === 'string' ? redactToken(value.message).slice(0, 180) : 'invalid value'
    return `${path}: ${message}`
  })
  return `${rendered.join('; ')}${issues.length > rendered.length ? `; and ${issues.length - rendered.length} more` : ''}`
}

export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(
    /** HTTP status, or 0 for a transport failure (fetch threw). */
    readonly status: number,
    /** The API `error` code (e.g. 'write_denied'), or 'transport'/'unknown'. */
    readonly code: string,
    /** The agent-facing actionable text. */
    private readonly agentText: string,
    /** The raw parsed body (for 422 → structuredContent). */
    readonly body: Json = undefined,
  ) {
    super(agentText)
  }

  /** The text surfaced in the tool error (already actionable; token-free). */
  toAgentText(): string {
    return this.agentText
  }

  /** For a 422 Shape-gate reject, the full RejectPayload to put in structuredContent. */
  rejectPayload(): RejectPayload | undefined {
    if (this.status === 422 && this.body && this.body.error === 'validation_failed') {
      return this.body as unknown as RejectPayload
    }
    return undefined
  }

  /** For a 422 DLP/PII reject, the redaction-safe findings to put in structuredContent. */
  piiPayload(): PiiPayload | undefined {
    if (this.status === 422 && this.body && this.body.error === 'pii_detected') {
      return this.body as unknown as PiiPayload
    }
    return undefined
  }

  /** Build from a non-2xx Response body. */
  static fromResponse(status: number, body: Json, apiUrl: string): ApiError {
    const code = typeof body?.error === 'string' ? body.error : 'unknown'
    const message = typeof body?.message === 'string' ? redactToken(body.message) : undefined

    if (status === 401) {
      return new ApiError(
        status,
        code,
        'Authentication failed — your PM_USER_TOKEN is invalid, expired, or revoked. ' +
          'Re-issue a token from the dashboard webapp (shown once: System → Users → Issue token), ' +
          'update PM_USER_TOKEN in your MCP config (format <tokenId>.<secret>), then RESTART this MCP session.' +
          (message ? ` (api: ${message})` : ''),
        body,
      )
    }

    if (status === 403) {
      if (code === 'no_team') {
        return new ApiError(
          status,
          code,
          'Rejected — the MCP requires team membership. You are team-less (a global super-admin). ' +
            'Manage memories on the dashboard instead, or have an admin assign you a team.' +
            (message ? ` (api: ${message})` : ''),
          body,
        )
      }
      if (code === 'not_owner') {
        return new ApiError(
          status,
          code,
          'Rejected — you may only edit/delete memories you created. A team-admin or super-admin can ' +
            'edit any memory in the team.' +
            (message ? ` (api: ${message})` : ''),
          body,
        )
      }
      if (code === 'cross_team_denied') {
        return new ApiError(
          status,
          code,
          'Rejected — memory writes are current-team only through the MCP. Cross-team changes are ' +
            'dashboard-only (super-admin).' +
            (message ? ` (api: ${message})` : ''),
          body,
        )
      }
      if (code === 'scope_not_readable') {
        return new ApiError(
          status,
          code,
          'Scope rejected — a team in your `scope` does not exist. `scope` can only NARROW (reads are ' +
            'universal); an unknown team id is refused.' +
            (message ? ` (api: ${message})` : ''),
          body,
        )
      }
      return new ApiError(
        status,
        code,
        `Permission denied${message ? `: ${message}` : '.'} This action crosses teams or exceeds ` +
          'your role — writes never cross teams by design.',
        body,
      )
    }

    if (status === 422) {
      if (code === 'validation_failed') {
        return new ApiError(status, code, renderRejectPayload(body as unknown as RejectPayload), body)
      }
      if (code === 'pii_detected') {
        return new ApiError(status, code, renderPiiPayload(body as unknown as PiiPayload), body)
      }
      if (code === 'vector_dim_mismatch' || code === 'embedding_pin_mismatch') {
        return new ApiError(
          status,
          code,
          'Embedding pin mismatch (client-managed embeddings / client-bridge): the precomputed vector\'s model/dim ' +
            'does not match the server\'s active pin. ' +
            (message ? `${message} ` : '') +
            'The admin switched the pinned embedding model. The MCP reads the pin from GET /config ONCE ' +
            'at startup and the server cannot embed for you in client-bridge mode, so you must: ' +
            '(1) re-deploy your local embedding engine with the NEW pinned model (the model named above — ' +
            'e.g. `ollama pull <model>`), then (2) RESTART this MCP session so the bridge re-reads the pin ' +
            'and re-embeds with it. Tell the user to do this.',
          body,
        )
      }
      return new ApiError(
        status,
        code,
        `Request rejected (422)${message ? `: ${message}` : '.'}`,
        body,
      )
    }

    if (status === 400) {
      if (code === 'validation_error') {
        const issues = validationIssueSummary(body?.issues)
        return new ApiError(
          status,
          code,
          `Request shape rejected by the API: ${issues}. Fix only the named field(s) and retry the same tool. ` +
            '(This is a malformed-request error, distinct from the 422 Shape-gate.)',
          body,
        )
      }
      if (code === 'no_file') {
        return new ApiError(
          status,
          code,
          'No file part in the upload — `filePath` must point to a readable local file. ' +
            (message ? `(api: ${message})` : ''),
          body,
        )
      }
      if (code === 'query_required' || code === 'query_vector_required') {
        return new ApiError(
          status,
          code,
          'Internal mode mismatch — the MCP sent the wrong field for the active embedding mode. ' +
            'RESTART this MCP session so it re-reads GET /config.' +
            (message ? ` (api: ${message})` : ''),
          body,
        )
      }
      return new ApiError(status, code, `Bad request${message ? `: ${message}` : '.'}`, body)
    }

    if (status === 404) {
      return new ApiError(
        status,
        code,
        'Not found (or not readable by your team). Verify the id. Cross-team items you lack a grant ' +
          'for are indistinguishable from missing (the API fails closed).',
        body,
      )
    }

    if (status === 409) {
      return new ApiError(
        status,
        code,
        `Conflict${message ? `: ${message}` : '.'} ` +
          (code === 'upload_conflict'
            ? 'A concurrent upload of the same file is in flight — RETRY this ingest once; the retry ' +
              'updates the existing document instead of creating a duplicate.'
            : 'The resource changed or an operation is already in progress — retry shortly.'),
        body,
      )
    }

    if (status === 413) {
      return new ApiError(
        status,
        code,
        `File exceeds the ingest size limit${message ? ` (${message})` : ''}. Split or compress it and retry.`,
        body,
      )
    }

    if (status === 502) {
      return new ApiError(
        status,
        code,
        `The graph service is temporarily unavailable${message ? ` (${message})` : ''}. ` +
          'This is a transient backend issue, not your request — retry shortly.',
        body,
      )
    }

    if (status === 503 && code === 'fact_extraction_quota_exhausted') {
      return new ApiError(
        status,
        code,
        'Fact extraction is out of tokens. The memory was not saved.',
        body,
      )
    }

    if (status === 503 && (code.startsWith('extraction_provider_') || code === 'fact_extraction_provider_unavailable')) {
      return new ApiError(
        status,
        code,
        `Fact extraction is temporarily unavailable${message ? `: ${message}` : '.'} ` +
          'This happened during the memory Shape gate before persistence completed, so the memory was not saved. ' +
          'Retry shortly.',
        body,
      )
    }

    if (status >= 500) {
      return new ApiError(
        status,
        code,
        'The memory API hit an internal error. Retry once; if it persists, notify the user to check ' +
          'the persistent-memory-api logs.' +
          (message ? ` (api: ${message})` : ''),
        body,
      )
    }

    return new ApiError(
      status,
      code,
      `Unexpected API response (HTTP ${status})${message ? `: ${message}` : '.'} The call could not be completed.`,
      body,
    )
  }

  /** Build from a thrown fetch error (network / DNS / connection refused / abort). */
  static transport(method: string, path: string, apiUrl: string, cause: unknown): ApiError {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const aborted = cause instanceof Error && cause.name === 'AbortError'
    return new ApiError(
      0,
      aborted ? 'timeout' : 'transport',
      aborted
        ? `The request to the memory API timed out (${method} ${path}). The API may be slow or unreachable — ` +
            `check it is up (docker compose ps) and retry.`
        : `Cannot reach the memory API at ${apiUrl} (${reason}). Check the API is running ` +
            `(docker compose ps) and API_URL is correct, then retry.`,
    )
  }
}

/** Pretty-print the RejectPayload so the agent can rewrite + retry in one turn. */
function renderRejectPayload(p: RejectPayload): string {
  const lines: string[] = []
  lines.push('The memory FAILED the Shape A–E write gate (422). Rewrite content/metadata and retry — ')
  lines.push('do NOT resend the same payload.')
  lines.push('')
  lines.push(`reason: ${p.reason}`)
  if (p.missing?.length) lines.push(`missing: ${p.missing.join(', ')}`)
  if (p.rewrite_templates && Object.keys(p.rewrite_templates).length) {
    lines.push('')
    lines.push('rewrite_templates (pick the one for your category):')
    for (const [shape, tmpl] of Object.entries(p.rewrite_templates)) {
      lines.push(`  • ${shape}: ${tmpl}`)
    }
  }
  if (p.entity_format !== undefined) {
    lines.push('')
    lines.push(`entity_format: ${typeof p.entity_format === 'string' ? p.entity_format : JSON.stringify(p.entity_format)}`)
  }
  if (p.valid_categories?.length) lines.push(`valid_categories: ${p.valid_categories.join(', ')}`)
  if (p.valid_sources?.length) lines.push(`valid_sources: ${p.valid_sources.join(', ')}`)
  if (p.suggestion) {
    lines.push('')
    lines.push(`suggestion: ${p.suggestion}`)
  }
  lines.push('')
  lines.push('(The full RejectPayload is in this tool result\'s structuredContent.)')
  return lines.join('\n')
}

/** Pretty-print the PII reject so the agent removes the sensitive data and retries. */
function renderPiiPayload(p: PiiPayload): string {
  const lines: string[] = []
  lines.push('The memory was BLOCKED by the DLP/PII gate (422) — it contains PII or a secret.')
  lines.push('Do NOT resend the same content. Remove the sensitive data, then retry.')
  lines.push('')
  lines.push(`reason: ${p.reason}`)
  if (p.findings?.length) {
    lines.push('')
    lines.push('findings (type only — the value is never echoed back):')
    for (const f of p.findings) {
      lines.push(`  • ${f.detector}: ${f.finding_type} [${f.severity}]`)
    }
  }
  if (p.guidance) {
    lines.push('')
    lines.push(`guidance: ${p.guidance}`)
  }
  return lines.join('\n')
}
