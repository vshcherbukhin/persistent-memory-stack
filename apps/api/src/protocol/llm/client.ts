/**
 * persistent-memory-api — extraction-LLM client abstraction (Phase 7).
 *
 * The validation gate makes ONE classification call per write to decide
 * accept/restructure/reject. The provider is pluggable via EXTRACTION_PROVIDER
 * (same env contract as the graphiti-service config.py — no new provider axis):
 *
 *   • anthropic — Anthropic Messages API (prod default; ANTHROPIC_API_KEY, or an
 *                 sk-ant-oat… token as a dev affordance). Uses structured
 *                 outputs (output_config.format json_schema) on the configured
 *                 model (claude-sonnet-4-6 default) for a guaranteed-parseable verdict.
 *   • openai    — OpenAI-compatible Chat Completions. Real OpenAI uses STRICT
 *                 Structured Outputs (json_schema, strict:true). The local-Ollama
 *                 test path (EXTRACTION_BASE_URL=…/v1) falls back to json_object,
 *                 where the tolerant parseVerdict() fence-strip is load-bearing.
 *
 * This is an API-boundary concern (LLM SDK + reads the prompt .md from disk), so
 * it lives in api/src/protocol/, NOT @pm/shared (Prisma-free AND LLM-SDK-free).
 */

/** The verdict the fact-extraction prompt emits (prompt §1). */
export interface VerdictRaw {
  outcome: 'accept' | 'restructure' | 'reject'
  facts: string[]
  restructured_content: string
  reason: string
  missing: string[]
  /** Optional human hint — kept only if the LLM set one (prompt may include it). */
  suggestion?: string
  /** Phase 9: the LLM's verbal confidence (0..1) that the memory is well-formed +
   *  the metadata valid. Optional/tolerant — absent → undefined (the route falls back
   *  to a provenance-derived default). NEVER used without the provenance gate. */
  confidence?: number
}

export interface ExtractionLLM {
  /**
   * One classification call. systemPrompt = fact-extraction.md;
   * userJson = JSON.stringify({ content, metadata }).
   * Throws LlmResponseError if the response cannot be parsed into a VerdictRaw.
   */
  classify(
    systemPrompt: string,
    userJson: string,
    options?: { signal?: AbortSignal },
  ): Promise<VerdictRaw>
}

/** Raised when the LLM returns JSON the gate cannot parse into a verdict. */
export class LlmResponseError extends Error {
  override readonly name = 'LlmResponseError'
  constructor(message: string) {
    super(message)
  }
}

export class LlmProviderError extends Error {
  override readonly name = 'LlmProviderError'
  override readonly cause: unknown

  constructor(
    readonly code:
      | 'extraction_provider_overloaded'
      | 'extraction_provider_rate_limited'
      | 'fact_extraction_quota_exhausted'
      | 'fact_extraction_provider_unavailable',
    message: string,
    readonly provider: string,
    readonly model: string,
    readonly upstreamStatus: number,
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super(message)
    this.cause = cause
  }

  /** Safe fields for API logs; the provider response is intentionally excluded. */
  toLogFields(): {
    code: LlmProviderError['code']
    provider: string
    model: string
    upstreamStatus: number
    retryable: boolean
  } {
    return {
      code: this.code,
      provider: this.provider,
      model: this.model,
      upstreamStatus: this.upstreamStatus,
      retryable: this.retryable,
    }
  }
}

function upstreamValues(err: unknown, field: 'type' | 'code' | 'message', depth = 0): string[] {
  if (!err || typeof err !== 'object' || depth > 3) return []
  const record = err as Record<string, unknown>
  const own = typeof record[field] === 'string' ? [record[field] as string] : []
  return [...own, ...upstreamValues(record.error, field, depth + 1)]
}
function upstreamErrorType(err: unknown): string | undefined { return upstreamValues(err, 'type')[0] }

function upstreamStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const status = (err as Record<string, unknown>).status
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

function upstreamErrorCode(err: unknown): string | undefined { return upstreamValues(err, 'code')[0] }
function upstreamErrorMessage(err: unknown): string | undefined { return upstreamValues(err, 'message').join(' ') || undefined }

function isQuotaExhausted(type: string | undefined, code: string | undefined, message: string): boolean {
  const signal = `${type ?? ''} ${code ?? ''} ${message}`.toLowerCase()
  return /insufficient[_\s-]?(quota|credit)|quota[_\s-]?exceeded|budget[_\s-]?exceeded|billing_hard_limit/.test(signal)
    || /out of (tokens?|credits?)|token (budget|limit).*(exhausted|exceeded)|(?:quota|credits?|budget).*(exhausted|exceeded|remaining)/.test(signal)
}

export function classifyProviderFailure(
  provider: string,
  model: string,
  err: unknown,
): LlmProviderError | null {
  const status = upstreamStatus(err)
  const type = upstreamErrorType(err)
  const code = upstreamErrorCode(err)
  const message = [err instanceof Error ? err.message : '', upstreamErrorMessage(err)].filter(Boolean).join(' ')

  if (isQuotaExhausted(type, code, message)) {
    return new LlmProviderError(
      'fact_extraction_quota_exhausted',
      'Fact extraction is out of tokens. The memory was not saved.',
      provider,
      model,
      status ?? 402,
      false,
      err,
    )
  }

  if (status === 529 || type === 'overloaded_error' || /overload/i.test(message)) {
    return new LlmProviderError(
      'extraction_provider_overloaded',
      `Fact extraction provider ${provider} is overloaded while validating memory content. Retry shortly; the memory was not saved.`,
      provider,
      model,
      status ?? 529,
      true,
      err,
    )
  }
  if (status === 429 || type === 'rate_limit_error') {
    return new LlmProviderError(
      'extraction_provider_rate_limited',
      `Fact extraction provider ${provider} is rate-limited while validating memory content. Retry shortly; the memory was not saved.`,
      provider,
      model,
      status ?? 429,
      true,
      err,
    )
  }
  return new LlmProviderError(
    'fact_extraction_provider_unavailable',
    'Fact extraction provider is unavailable. The memory was not saved.',
    provider,
    model,
    status ?? 503,
    true,
    err,
  )
}

/**
 * The JSON schema pinning the verdict shape for Anthropic structured outputs.
 * additionalProperties:false + the five required keys eliminate the Python
 * fence-strip path. `suggestion` is intentionally NOT required.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['accept', 'restructure', 'reject'] },
    facts: { type: 'array', items: { type: 'string' } },
    restructured_content: { type: 'string' },
    reason: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
    // NOTE: no minimum/maximum — Anthropic structured outputs reject numeric range
    // constraints ("For 'number' type, properties maximum, minimum are not supported").
    // parseVerdict clamps to [0,1] server-side, so the range is still enforced.
    confidence: { type: 'number' },
  },
  required: ['outcome', 'facts', 'restructured_content', 'reason', 'missing'],
  additionalProperties: false,
} as const

/**
 * Strict variant for OpenAI Structured Outputs. OpenAI strict mode requires EVERY
 * property to appear in `required`, so `suggestion` is required + nullable here
 * (`type: ['string','null']`). parseVerdict already treats a null/empty suggestion
 * as absent, so the shape round-trips identically to the Anthropic path.
 */
export const VERDICT_SCHEMA_STRICT = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['accept', 'restructure', 'reject'] },
    facts: { type: 'array', items: { type: 'string' } },
    restructured_content: { type: 'string' },
    reason: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    suggestion: { type: ['string', 'null'] },
    confidence: { type: ['number', 'null'] }, // range enforced by parseVerdict (clamp)
  },
  required: ['outcome', 'facts', 'restructured_content', 'reason', 'missing', 'suggestion', 'confidence'],
  additionalProperties: false,
} as const

/**
 * Tolerant verdict parse. Strips ```lang … ``` fencing if present (ports
 * validation.py _haiku_validate lines 215–219) before JSON.parse, then
 * normalizes the shape. Used by BOTH backends — the Anthropic structured-output
 * path rarely needs the fence strip, but the OpenAI-compat/Ollama path (weaker
 * json_object mode) routinely does. A parse failure throws LlmResponseError,
 * which the gate maps to a 422 (mirrors the Python JSONDecodeError path).
 */
export function parseVerdict(raw: string): VerdictRaw {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '').trim()
  }

  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (err) {
    throw new LlmResponseError(
      `extraction LLM returned unparseable JSON: ${(err as Error).message}`,
    )
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new LlmResponseError('extraction LLM returned non-object JSON')
  }

  const v = obj as Record<string, unknown>
  const outcome = v.outcome
  if (outcome !== 'accept' && outcome !== 'restructure' && outcome !== 'reject') {
    throw new LlmResponseError(`extraction LLM returned unknown outcome: ${String(outcome)}`)
  }

  return {
    outcome,
    facts: Array.isArray(v.facts) ? v.facts.map(String) : [],
    restructured_content:
      typeof v.restructured_content === 'string' ? v.restructured_content : '',
    reason: typeof v.reason === 'string' ? v.reason : '',
    missing: Array.isArray(v.missing) ? v.missing.map(String) : [],
    suggestion: typeof v.suggestion === 'string' && v.suggestion ? v.suggestion : undefined,
    confidence:
      typeof v.confidence === 'number' && Number.isFinite(v.confidence)
        ? Math.min(1, Math.max(0, v.confidence)) // clamp to [0,1]; out-of-range → clamped
        : undefined,
  }
}

/**
 * Cost/speed-first default model per provider (full id, not a stale alias): Anthropic
 * Haiku 4.5 for extraction; OpenAI gpt-4o. Overridden by EXTRACTION_MODEL.
 */
export function resolveExtractionModel(provider: string, envModel?: string): string {
  return envModel && envModel.trim() ? envModel : provider === 'openai' ? 'gpt-4o' : 'claude-haiku-4-5-20251001'
}

/** Build the EXTRACTION_PROVIDER-driven client. Lazy-imports the backend. */
export async function makeExtractionLLM(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExtractionLLM> {
  const provider = env.EXTRACTION_PROVIDER ?? 'anthropic'
  const model = resolveExtractionModel(provider, env.EXTRACTION_MODEL)

  switch (provider) {
    case 'anthropic': {
      const { AnthropicExtractionLLM } = await import('./anthropic.ts')
      return new AnthropicExtractionLLM(model, env)
    }
    case 'openai': {
      const { OpenAICompatExtractionLLM } = await import('./openai-compat.ts')
      return new OpenAICompatExtractionLLM(model, env)
    }
    default:
      throw new Error(
        `EXTRACTION_PROVIDER="${provider}" invalid — expected "anthropic" or "openai".`,
      )
  }
}
