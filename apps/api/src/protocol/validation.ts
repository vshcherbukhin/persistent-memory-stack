/**
 * persistent-memory-api — the Shape A–E write gate (Phase 7).
 *
 * validateAndRoute(content, metadata) → accept | restructure, or THROWS a 422
 * ValidationError on reject. Ports lib/validation.py::validate_and_route to TS,
 * cheap-deterministic-FIRST / LLM-SECOND (the Python version is LLM-only; the TS
 * port adds a pre-gate so the common reject paths never spend a Haiku call and
 * the 422 payload is identical to mem0's).
 *
 * Stage 1 — deterministic pre-gate (no LLM, mirrors fact-extraction.md §4/§5):
 *   collect ALL applicable missing[] keys (no short-circuit), then throw once.
 * Stage 2 — LLM verdict (only if Stage 1 passes): one EXTRACTION_PROVIDER call
 *   with the fact-extraction system prompt. Haiku owns entity-QUALITY judgment
 *   (camelCase/hyphen/generic/leading-article) + accept-vs-restructure shape.
 *
 * The verbatim-entity gate is the load-bearing rule (prompt §2/§5): a STRICT,
 * case-sensitive substring — NO normalization, NO snake_case↔camelCase. It is an
 * OR over the whole set (`entities.some(e => content.includes(e))`), and it ALSO
 * fires when entities is missing/empty. Entity QUALITY (per-entry) is delegated
 * to the LLM. Mixing these two up is the most likely porting bug.
 */
import { ValidationError, PiiDetectedError, type RejectPayload } from '../authz/errors.ts'
import type { MemoryShape } from '@pm/db'
import { makeDlpClient, dlpGate, resolvePiiEntities, type DlpClient } from '@pm/security-dlp'
import { config } from '../config.ts'
import {
  VALID_CATEGORIES,
  VALID_SOURCES,
  ENTITY_TOKEN_REGEX,
  ENTITY_FORMAT_GUIDANCE,
  SHAPE_TEMPLATES,
  EXCERPT_LIMIT,
  deriveShape,
} from './shapes.ts'
import {
  type ExtractionLLM,
  LlmResponseError,
} from './llm/client.ts'
import { FACT_EXTRACTION_PROMPT } from './prompt.ts'
import {
  factExtractionCacheKey,
  classifyFactExtraction,
  getFactExtractionRuntimeConfig,
  envForFactExtractionRuntime,
} from '../services/fact-extraction.ts'
import { makeExtractionLLM } from './llm/client.ts'

/** Write metadata as it arrives from the route (post-Zod). */
export interface WriteMetadata {
  category?: string
  entities?: string[]
  source?: string
  severity?: string
  epic?: string
  feature?: string
  pageId?: string
  confluenceUrl?: string
  [k: string]: unknown
}

export type RouteResult =
  | { outcome: 'accept'; content: string; shape: MemoryShape; confidence?: number }
  | { outcome: 'restructure'; content: string; original: string; shape: MemoryShape; confidence?: number }

/** Build the actionable 422 body (ports MCPValidationError.payload). */
function buildRejectPayload(
  reason: string,
  missing: string[],
  ctx: { content?: string; metadata?: unknown; suggestion?: string },
): RejectPayload {
  const content = ctx.content
  const length = content ? content.length : 0
  const excerpt =
    content == null
      ? null
      : length <= EXCERPT_LIMIT
        ? content
        : content.slice(0, EXCERPT_LIMIT) + '…'

  const payload: RejectPayload = {
    error: 'validation_failed',
    reason,
    missing,
    rewrite_templates: { ...SHAPE_TEMPLATES },
    entity_format: ENTITY_FORMAT_GUIDANCE,
    valid_categories: VALID_CATEGORIES,
    valid_sources: VALID_SOURCES,
    your_submission: {
      content_excerpt: excerpt,
      content_length: length,
      metadata_received: ctx.metadata ?? null,
    },
  }
  if (ctx.suggestion) payload.suggestion = ctx.suggestion
  return payload
}

function reject(
  reason: string,
  missing: string[],
  ctx: { content?: string; metadata?: unknown; suggestion?: string },
): never {
  throw new ValidationError(buildRejectPayload(reason, missing, ctx))
}

/**
 * Stage 1 — deterministic pre-gate. Returns the full missing[] (no
 * short-circuit). Throws nothing; the caller decides whether to reject.
 */
export function preGate(content: string, metadata: WriteMetadata): string[] {
  const missing: string[] = []

  if (content.length < 40) missing.push('content_too_short')
  if (!ENTITY_TOKEN_REGEX.test(content)) missing.push('no_entity_token_in_content')

  const category = metadata.category
  if (!category || !(VALID_CATEGORIES as readonly string[]).includes(category)) {
    missing.push('metadata.category')
  }

  const entities = metadata.entities
  if (!Array.isArray(entities) || entities.length === 0) {
    missing.push('metadata.entities')
  }

  const source = metadata.source
  if (!source || !(VALID_SOURCES as readonly string[]).includes(source)) {
    missing.push('metadata.source')
  }

  // Verbatim entity-in-content (strict, case-sensitive substring; OR over the
  // set). Fires when NONE appears verbatim — which includes missing/empty
  // entities (prompt §5 note: graph_entity_in_content + metadata.entities both
  // fire in that case).
  const anyVerbatim =
    Array.isArray(entities) && entities.length > 0
      ? entities.some((e) => typeof e === 'string' && content.includes(e))
      : false
  if (!anyVerbatim) missing.push('graph_entity_in_content')

  if (category === 'prd') {
    if (!metadata.pageId) missing.push('metadata.pageId')
    if (!metadata.confluenceUrl) missing.push('metadata.confluenceUrl')
  }

  return missing
}

/** Lazily-built singleton client (one Haiku/Ollama connection per process). */
let _llm: ExtractionLLM | null = null
let _configuredLlm: ExtractionLLM | null = null
let _configuredLlmKey: string | null = null
async function getLlm(): Promise<{ llm: ExtractionLLM; runtime: Awaited<ReturnType<typeof getFactExtractionRuntimeConfig>> | null }> {
  if (_llm) return { llm: _llm, runtime: null }
  const runtime = await getFactExtractionRuntimeConfig()
  const key = factExtractionCacheKey(runtime)
  if (!_configuredLlm || _configuredLlmKey !== key) {
    _configuredLlm = await makeExtractionLLM(envForFactExtractionRuntime(runtime))
    _configuredLlmKey = key
  }
  return { llm: _configuredLlm, runtime }
}

/** Test seam: inject a stub ExtractionLLM (vitest) instead of the real backend. */
export function __setExtractionLLM(llm: ExtractionLLM | null): void {
  _llm = llm
  if (llm === null) {
    _configuredLlm = null
    _configuredLlmKey = null
  }
}

/** Lazily-built DLP client (one connection to the sidecar per process). */
let _dlp: DlpClient | null = null
function getDlp(): DlpClient {
  if (!_dlp) _dlp = makeDlpClient({ baseUrl: config.DLP_URL, timeoutMs: config.DLP_TIMEOUT_MS })
  return _dlp
}

/** Test seam: inject a stub DlpClient (vitest) instead of the real sidecar. */
export function __setDlpClient(client: DlpClient | null): void {
  _dlp = client
}

const PII_ENTITIES = resolvePiiEntities(config.PII_ENTITIES)

/**
 * Stage 1.5 — the DLP/PII gate. Runs between the deterministic pre-gate and the LLM
 * (cheap-first: don't spend a DLP call if Stage 1 already failed, don't spend a Haiku
 * call if PII is present). FAIL-CLOSED via dlpGate: an unreachable/erroring sidecar
 * blocks the write. Throws PiiDetectedError (422) with a redaction-safe findings list.
 */
export async function assertNoPii(content: string): Promise<void> {
  if (!config.PII_GATE_ENABLED) return
  const result = await dlpGate(getDlp(), content, {
    entities: PII_ENTITIES,
    scoreThreshold: config.PII_SCORE_THRESHOLD,
  })
  if (!result.blocked) return
  throw new PiiDetectedError({
    error: 'pii_detected',
    reason: result.failClosed
      ? 'The DLP scanner is unavailable — the write is blocked (fail-closed).'
      : 'The memory contains PII or a secret and was blocked. Remove the sensitive data and retry.',
    findings: result.findings.map((f) => ({
      detector: f.detector,
      finding_type: f.findingType,
      severity: f.severity,
    })),
    guidance: result.failClosed
      ? 'Retry shortly; if it persists, the dlp sidecar is down — contact an admin.'
      : 'Redact the flagged value(s) (e.g. SSNs, credit cards, emails, API keys/tokens) from the content, then resubmit.',
  })
}

/**
 * The gate. accept/restructure return the content to store + the MemoryShape;
 * reject throws a 422 ValidationError carrying the actionable payload.
 */
export async function validateAndRoute(
  content: string,
  metadata: WriteMetadata,
): Promise<RouteResult> {
  // ── Stage 1: cheap deterministic pre-gate (no LLM round trip). ─────────────
  const missing = preGate(content, metadata)
  if (missing.length > 0) {
    reject('content failed the deterministic pre-gate; see missing[].', missing, {
      content,
      metadata,
    })
  }

  // ── Stage 1.5: DLP/PII gate (one sidecar call; before the LLM). Fail-closed. ─
  await assertNoPii(content)

  // ── Stage 2: LLM verdict (entity-quality + accept-vs-restructure). ─────────
  const { llm, runtime } = await getLlm()
  let verdict
  try {
    verdict = await classifyFactExtraction(
      llm,
      runtime,
      FACT_EXTRACTION_PROMPT,
      JSON.stringify({ content, metadata }),
    )
  } catch (err) {
    if (err instanceof LlmResponseError) {
      reject(err.message, ['llm_response_malformed'], { content, metadata })
    }
    throw err // a real backend/network error → bubble to the 500 handler
  }

  if (verdict.outcome === 'reject') {
    reject(verdict.reason || 'content failed validation', verdict.missing ?? [], {
      content,
      metadata,
      suggestion: verdict.suggestion,
    })
  }

  if (verdict.outcome === 'restructure') {
    const restructured = verdict.restructured_content
    if (!restructured) {
      // Haiku said restructure but gave nothing → reject (port validation.py).
      reject(
        'restructure verdict missing restructured_content',
        ['restructured_content'],
        { content, metadata },
      )
    }
    return {
      outcome: 'restructure',
      content: restructured,
      original: content,
      shape: deriveShape('restructure', metadata.category ?? '', restructured),
      confidence: verdict.confidence,
    }
  }

  if (verdict.outcome === 'accept') {
    return {
      outcome: 'accept',
      content,
      shape: deriveShape('accept', metadata.category ?? '', content),
      confidence: verdict.confidence,
    }
  }

  // Unreachable (parseVerdict already validated the enum) — defensive.
  reject(`unknown outcome: ${String(verdict.outcome)}`, ['outcome'], { content, metadata })
}
