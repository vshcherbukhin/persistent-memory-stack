/**
 * Unit matrix for the Phase 7 Shape A–E write gate (validateAndRoute).
 *
 * The deterministic pre-gate (Stage 1) needs NO LLM and NO DB — it's pure TS, so
 * the reject paths run without any backend. For accept/restructure (Stage 2) we
 * inject a stub ExtractionLLM via __setExtractionLLM so the test never hits
 * Anthropic/Ollama. validation.ts imports MemoryShape type-only from @pm/db
 * (erased) and ValidationError from authz/errors (no DB), so importing it here
 * does not open a pool or validate config env.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  validateAndRoute,
  preGate,
  assertNoPii,
  __setExtractionLLM,
  __setDlpClient,
} from '../src/protocol/validation.ts'
import { ValidationError, PiiDetectedError } from '../src/authz/errors.ts'
import {
  deriveShape,
  VALID_CATEGORIES,
  VALID_SOURCES,
  SHAPE_TEMPLATES,
  ENTITY_FORMAT_GUIDANCE,
} from '../src/protocol/shapes.ts'
import type { ExtractionLLM, VerdictRaw } from '../src/protocol/llm/client.ts'
import type { DlpClient, ScanResult } from '@pm/security-dlp'

/** A stub LLM that returns a canned verdict (Stage 2 never calls a real backend). */
function stubLlm(verdict: VerdictRaw): ExtractionLLM {
  return { classify: async () => verdict }
}

/** A stub DLP client so the Stage-1.5 PII gate never hits the real sidecar. */
function stubDlp(result: ScanResult): DlpClient {
  return { scan: async () => result }
}
const CLEAN_SCAN: ScanResult = { pii: [], secrets: [], block: false }

const GOOD_META = {
  category: 'gotcha',
  entities: ['component_floating_overlay'],
  source: 'heal-cycle' as const,
}
const GOOD_CONTENT =
  '[component_floating_overlay] Clicks intercepted after dropdown. ' +
  'Root cause: overlay not dismissed. Fix: dismiss via testid. Prevention: all callers dismiss.'

beforeEach(() => {
  __setExtractionLLM(null) // reset the injected client between tests
  __setDlpClient(stubDlp(CLEAN_SCAN)) // default: PII gate sees clean content
})

describe('preGate — deterministic Stage 1 (no LLM)', () => {
  it('passes a well-formed Shape A memory (empty missing[])', () => {
    expect(preGate(GOOD_CONTENT, GOOD_META)).toEqual([])
  })

  it('flags content < 40 chars', () => {
    expect(preGate('too short', GOOD_META)).toContain('content_too_short')
  })

  it('flags no <type>_<specific_name> token in content', () => {
    const content = 'a'.repeat(50) + ' no entity token here just words and words'
    expect(preGate(content, { category: 'gotcha', source: 'heal-cycle', entities: ['x'] })).toContain(
      'no_entity_token_in_content',
    )
  })

  it('flags an invalid category', () => {
    expect(preGate(GOOD_CONTENT, { ...GOOD_META, category: 'nonsense' })).toContain(
      'metadata.category',
    )
  })

  it('flags an invalid source', () => {
    expect(preGate(GOOD_CONTENT, { ...GOOD_META, source: 'made-up' })).toContain('metadata.source')
  })

  it('flags empty entities AND graph_entity_in_content together', () => {
    const missing = preGate(GOOD_CONTENT, { category: 'gotcha', source: 'heal-cycle', entities: [] })
    expect(missing).toContain('metadata.entities')
    expect(missing).toContain('graph_entity_in_content')
  })

  it('verbatim entity check is CASE-SENSITIVE (component_Checkbox != component_checkbox)', () => {
    const content =
      'The component_Checkbox does not register clicks while a modal is open and the overlay intercepts.'
    const missing = preGate(content, {
      category: 'gotcha',
      source: 'heal-cycle',
      entities: ['component_checkbox'],
    })
    expect(missing).toContain('graph_entity_in_content')
  })

  it('passes verbatim when the entity appears exactly in content', () => {
    const content =
      'The component_checkbox does not register clicks while a modal is open and the overlay intercepts.'
    const missing = preGate(content, {
      category: 'gotcha',
      source: 'heal-cycle',
      entities: ['component_checkbox'],
    })
    expect(missing).not.toContain('graph_entity_in_content')
  })

  it('prd category requires pageId + confluenceUrl', () => {
    const content =
      '[prd_audit_export] Audit exports must exclude revoked credentials while a workspace is under legal hold.'
    const missing = preGate(content, {
      category: 'prd',
      source: 'confluence',
      entities: ['prd_audit_export'],
    })
    expect(missing).toContain('metadata.pageId')
    expect(missing).toContain('metadata.confluenceUrl')
  })
})

describe('validateAndRoute — reject path throws 422 ValidationError with payload', () => {
  it('rejects on Stage 1 failure WITHOUT calling the LLM', async () => {
    // No stub installed; if Stage 2 ran it would throw "no client". A pre-gate
    // failure must short-circuit before that.
    await expect(validateAndRoute('too short', {})).rejects.toBeInstanceOf(ValidationError)
    try {
      await validateAndRoute('too short', {})
    } catch (e) {
      const err = e as ValidationError
      expect(err.statusCode).toBe(422)
      expect(err.payload.error).toBe('validation_failed')
      expect(err.payload.missing).toContain('content_too_short')
      // The actionable payload carries the rewrite templates incl. Shape E.
      expect(err.payload.rewrite_templates.E).toContain('Why it matters:')
      expect(err.payload.valid_categories).toContain('gotcha')
      expect(err.payload.your_submission.content_length).toBe('too short'.length)
    }
  })

  it('rejects when the LLM returns reject (entity_quality)', async () => {
    __setExtractionLLM(
      stubLlm({
        outcome: 'reject',
        facts: [],
        restructured_content: '',
        reason: "entity 'the_test' uses a leading-article prefix",
        missing: ['entity_quality'],
      }),
    )
    await expect(validateAndRoute(GOOD_CONTENT, GOOD_META)).rejects.toMatchObject({
      statusCode: 422,
    })
  })
})

describe('validateAndRoute — accept / restructure', () => {
  it('accepts a Shape A memory and maps category gotcha → gotcha_fix', async () => {
    __setExtractionLLM(
      stubLlm({
        outcome: 'accept',
        facts: [GOOD_CONTENT],
        restructured_content: '',
        reason: '',
        missing: [],
      }),
    )
    const res = await validateAndRoute(GOOD_CONTENT, GOOD_META)
    expect(res.outcome).toBe('accept')
    expect(res.content).toBe(GOOD_CONTENT)
    expect(res.shape).toBe('gotcha_fix')
  })

  it('restructure ALWAYS maps to gotcha_fix and stores restructured_content', async () => {
    const rewritten =
      '[component_checkbox] Click does not register when a modal is open. ' +
      'Root cause: overlay intercepts. Fix: dismiss overlay first. Prevention: always dismiss.'
    __setExtractionLLM(
      stubLlm({
        outcome: 'restructure',
        facts: [rewritten],
        restructured_content: rewritten,
        reason: '',
        missing: [],
      }),
    )
    const content =
      'When you click the component_checkbox while a modal is open the click sometimes does not register.'
    const res = await validateAndRoute(content, {
      category: 'gotcha',
      entities: ['component_checkbox'],
      source: 'gotcha-discovered',
    })
    expect(res.outcome).toBe('restructure')
    if (res.outcome === 'restructure') {
      expect(res.content).toBe(rewritten)
      expect(res.original).toBe(content)
      expect(res.shape).toBe('gotcha_fix')
    }
  })

  it('rejects when restructure verdict has no restructured_content', async () => {
    __setExtractionLLM(
      stubLlm({
        outcome: 'restructure',
        facts: [],
        restructured_content: '',
        reason: '',
        missing: [],
      }),
    )
    await expect(validateAndRoute(GOOD_CONTENT, GOOD_META)).rejects.toMatchObject({
      statusCode: 422,
    })
  })

  it('maps an atomic accept (Why it matters:, no Shape-A markers) → atomic for flag-state', async () => {
    const content =
      '[tool_claude_code] CC injects a fresh CLAUDE_CODE_OAUTH_TOKEN into spawned MCP children. ' +
      'Why it matters: prefer the env var over the keychain copy which lags rotations.'
    __setExtractionLLM(
      stubLlm({
        outcome: 'accept',
        facts: [content],
        restructured_content: '',
        reason: '',
        missing: [],
      }),
    )
    const res = await validateAndRoute(content, {
      category: 'flag-state',
      entities: ['tool_claude_code'],
      source: 'gotcha-discovered',
    })
    expect(res.shape).toBe('atomic')
  })
})

describe('parseVerdict (via client) — tolerant fence-strip', async () => {
  const { parseVerdict, LlmResponseError, classifyProviderFailure } = await import('../src/protocol/llm/client.ts')

  it('strips ```json fences', () => {
    const raw = '```json\n{"outcome":"accept","facts":["x"],"restructured_content":"","reason":"","missing":[]}\n```'
    expect(parseVerdict(raw).outcome).toBe('accept')
  })

  it('throws LlmResponseError on unparseable JSON', () => {
    expect(() => parseVerdict('not json at all')).toThrow(LlmResponseError)
  })

  it('throws LlmResponseError on an unknown outcome', () => {
    const raw = '{"outcome":"maybe","facts":[],"restructured_content":"","reason":"","missing":[]}'
    expect(() => parseVerdict(raw)).toThrow(LlmResponseError)
  })

  it('classifies provider overloads as retryable fact-extraction failures', () => {
    const err = classifyProviderFailure('Anthropic', 'claude-haiku-4-5-20251001', {
      status: 529,
      error: { error: { type: 'overloaded_error', message: 'Overloaded' } },
    })

    expect(err).toMatchObject({
      code: 'extraction_provider_overloaded',
      provider: 'Anthropic',
      model: 'claude-haiku-4-5-20251001',
      upstreamStatus: 529,
    })
    expect(err?.message).toMatch(/not saved/i)
  })
})

// ── Shape A–E coverage via the full accept path (validateAndRoute → MemoryShape). ─
//
// Each category drives deriveShape through validateAndRoute (not just the pure
// helper), proving the gate maps the open `category` vocabulary onto the closed
// MemoryShape enum exactly per prompt §1/§4. Stubbed LLM = accept; the route's
// content + metadata.category own the shape decision.
describe('validateAndRoute — Shape A–E mapping (accept path, every category)', () => {
  const accept = (content: string): void =>
    __setExtractionLLM(
      stubLlm({ outcome: 'accept', facts: [content], restructured_content: '', reason: '', missing: [] }),
    )

  it('Shape A — category "gotcha" → gotcha_fix', async () => {
    const content =
      '[component_alpha_panel] Click intercepted by stale overlay. ' +
      'Root cause: not dismissed. Fix: dismiss via testid. Prevention: all callers dismiss.'
    accept(content)
    const res = await validateAndRoute(content, {
      category: 'gotcha',
      entities: ['component_alpha_panel'],
      source: 'heal-cycle',
    })
    expect(res.outcome).toBe('accept')
    expect(res.shape).toBe('gotcha_fix')
  })

  it('Shape A — category "fix" also → gotcha_fix', async () => {
    const content =
      '[component_beta_grid] Rows duplicated on re-render. ' +
      'Root cause: missing key. Fix: stable key. Prevention: lint rule.'
    accept(content)
    const res = await validateAndRoute(content, {
      category: 'fix',
      entities: ['component_beta_grid'],
      source: 'test-failure',
    })
    expect(res.shape).toBe('gotcha_fix')
  })

  it('Shape B — category "user-correction" → user_correction', async () => {
    const content =
      '[task_save_flow] Tried saving on blur, because it felt natural. ' +
      'User said save on explicit submit only. Correct: submit button. Key insight: no implicit writes.'
    accept(content)
    const res = await validateAndRoute(content, {
      category: 'user-correction',
      entities: ['task_save_flow'],
      source: 'user-correction',
    })
    expect(res.shape).toBe('user_correction')
  })

  it('Shape C — category "tool-gap" → tool_gap', async () => {
    const content =
      '[tool_search_memories] query returns vector hits but does NOT include graph edges. ' +
      'Workaround: call mcp_search_graph after. Useful for: associative recall.'
    accept(content)
    const res = await validateAndRoute(content, {
      category: 'tool-gap',
      entities: ['tool_search_memories'],
      source: 'gotcha-discovered',
    })
    expect(res.shape).toBe('tool_gap')
  })

  it('Shape D — category "prd" → prd (with pageId + confluenceUrl)', async () => {
    const content =
      '[prd_audit_export] Audit exports must retain immutable history while a workspace is under legal hold.'
    accept(content)
    const res = await validateAndRoute(content, {
      category: 'prd',
      entities: ['prd_audit_export'],
      source: 'confluence',
      pageId: '123456',
      confluenceUrl: 'https://example.atlassian.net/wiki/spaces/X/pages/123456',
    })
    expect(res.shape).toBe('prd')
  })

  it('Shape E — open category + "Why it matters:" w/o Shape-A markers → atomic', async () => {
    const content =
      '[flag_archive_rollout] Archive mode defaults OFF for workspaces created before 2026-01. ' +
      'Why it matters: a fresh session would assume archive mode is on and mis-route.'
    accept(content)
    const res = await validateAndRoute(content, {
      category: 'flag-state',
      entities: ['flag_archive_rollout'],
      source: 'gotcha-discovered',
    })
    expect(res.shape).toBe('atomic')
  })

  it('Shape A fallback — open category WITH Shape-A markers → gotcha_fix (not atomic)', async () => {
    const content =
      '[perm_admin_grant] Admin grant silently no-ops for read tokens. ' +
      'Root cause: scope check skipped. Fix: gate on team_role. Prevention: add guard test.'
    accept(content)
    const res = await validateAndRoute(content, {
      category: 'permission',
      entities: ['perm_admin_grant'],
      source: 'postmortem',
    })
    expect(res.shape).toBe('gotcha_fix')
  })
})

// ── deriveShape unit table (the pure helper backing the mappings above). ──────
describe('deriveShape — pure category/outcome/marker → MemoryShape', () => {
  it('restructure ALWAYS → gotcha_fix regardless of category', () => {
    expect(deriveShape('restructure', 'tool-gap', 'anything')).toBe('gotcha_fix')
    expect(deriveShape('restructure', 'prd', 'Why it matters: x')).toBe('gotcha_fix')
  })
  it('accept gotcha/fix → gotcha_fix', () => {
    expect(deriveShape('accept', 'gotcha', 'x')).toBe('gotcha_fix')
    expect(deriveShape('accept', 'fix', 'x')).toBe('gotcha_fix')
  })
  it('accept user-correction → user_correction', () => {
    expect(deriveShape('accept', 'user-correction', 'x')).toBe('user_correction')
  })
  it('accept tool-gap → tool_gap', () => {
    expect(deriveShape('accept', 'tool-gap', 'x')).toBe('tool_gap')
  })
  it('accept prd → prd', () => {
    expect(deriveShape('accept', 'prd', 'x')).toBe('prd')
  })
  it('open category + "Why it matters:" no Shape-A markers → atomic', () => {
    expect(deriveShape('accept', 'flag-state', 'fact. Why it matters: y')).toBe('atomic')
  })
  it('open category + "Root cause:" present → gotcha_fix (Shape-A wins over atomic)', () => {
    expect(deriveShape('accept', 'flag-state', 'Root cause: z. Why it matters: y')).toBe('gotcha_fix')
  })
  it('open category, no markers at all → gotcha_fix fallback', () => {
    expect(deriveShape('accept', 'migration-pattern', 'plain text no markers')).toBe('gotcha_fix')
  })
})

// ── Closed-enum gating: every valid value passes, anything else is rejected. ──
describe('preGate — closed category enum', () => {
  it('accepts every VALID_CATEGORIES member (no metadata.category in missing[])', () => {
    for (const category of VALID_CATEGORIES) {
      const extra =
        category === 'prd'
          ? { pageId: 'p1', confluenceUrl: 'https://x/y' }
          : {}
      const missing = preGate(GOOD_CONTENT, {
        category,
        entities: ['component_floating_overlay'],
        source: 'heal-cycle',
        ...extra,
      })
      expect(missing, `category=${category}`).not.toContain('metadata.category')
    }
  })

  it('rejects categories outside the closed set', () => {
    for (const bad of ['Gotcha', 'GOTCHA', 'fixes', 'note', '', 'prd ']) {
      expect(preGate(GOOD_CONTENT, { ...GOOD_META, category: bad }), `category=${JSON.stringify(bad)}`).toContain(
        'metadata.category',
      )
    }
  })
})

describe('preGate — closed source enum', () => {
  it('accepts every VALID_SOURCES member (no metadata.source in missing[])', () => {
    for (const source of VALID_SOURCES) {
      const missing = preGate(GOOD_CONTENT, { ...GOOD_META, source })
      expect(missing, `source=${source}`).not.toContain('metadata.source')
    }
  })

  it('rejects sources outside the closed set', () => {
    for (const bad of ['Heal-cycle', 'heal_cycle', 'manual', '', 'confluence ']) {
      expect(preGate(GOOD_CONTENT, { ...GOOD_META, source: bad }), `source=${JSON.stringify(bad)}`).toContain(
        'metadata.source',
      )
    }
  })
})

// ── Verbatim-entity gate: case-sensitive substring OR over the set. ───────────
describe('preGate — verbatim entity-in-content (load-bearing rule)', () => {
  const longTail =
    ' which is a long enough sentence to clear the 40-char minimum for content.'

  it('passes when ANY one entity of several appears verbatim (OR over the set)', () => {
    const content = '[component_present_one] something happened' + longTail
    const missing = preGate(content, {
      category: 'gotcha',
      source: 'heal-cycle',
      entities: ['component_absent_zero', 'component_present_one'],
    })
    expect(missing).not.toContain('graph_entity_in_content')
  })

  it('fires when NONE of the entities appears verbatim', () => {
    const content = '[component_present_one] something happened' + longTail
    const missing = preGate(content, {
      category: 'gotcha',
      source: 'heal-cycle',
      entities: ['component_absent_zero', 'component_absent_two'],
    })
    expect(missing).toContain('graph_entity_in_content')
  })

  it('is case-sensitive: a case-mismatched entity does NOT satisfy the gate', () => {
    const content = '[component_mixedcase] click not registered while modal open' + longTail
    const missing = preGate(content, {
      category: 'gotcha',
      source: 'heal-cycle',
      entities: ['component_MixedCase'],
    })
    expect(missing).toContain('graph_entity_in_content')
  })

  it('a non-string entry never satisfies the substring check', () => {
    const content = '[component_real] click not registered while modal open' + longTail
    // @ts-expect-error — exercising the typeof-string guard at runtime
    const missing = preGate(content, { category: 'gotcha', source: 'heal-cycle', entities: [42] })
    expect(missing).toContain('graph_entity_in_content')
  })
})

// ── Full reject-payload assertion (the actionable 422 body). ──────────────────
describe('validateAndRoute — reject payload is complete + self-correcting', () => {
  it('carries every Shape template, entity_format, both closed enums, and the echo', async () => {
    let caught: ValidationError | null = null
    try {
      await validateAndRoute('short', { category: 'nope', source: 'nope' })
    } catch (e) {
      caught = e as ValidationError
    }
    expect(caught).toBeInstanceOf(ValidationError)
    const p = caught!.payload
    expect(caught!.statusCode).toBe(422)
    expect(caught!.code).toBe('validation_failed')
    expect(p.error).toBe('validation_failed')

    // Aggregated missing[] (no short-circuit): all deterministic failures present.
    expect(p.missing).toEqual(
      expect.arrayContaining([
        'content_too_short',
        'no_entity_token_in_content',
        'metadata.category',
        'metadata.entities',
        'metadata.source',
        'graph_entity_in_content',
      ]),
    )

    // Rewrite templates A–E echoed verbatim from the source of truth.
    expect(p.rewrite_templates).toMatchObject(SHAPE_TEMPLATES)
    expect(Object.keys(p.rewrite_templates).sort()).toEqual(['A', 'B', 'C', 'D', 'E'])

    // Closed enums echoed so the agent can self-correct without a server fetch.
    expect(p.valid_categories).toEqual(VALID_CATEGORIES)
    expect(p.valid_sources).toEqual(VALID_SOURCES)
    expect(p.entity_format).toMatchObject({ pattern: ENTITY_FORMAT_GUIDANCE.pattern })

    // Submission echo: excerpt + true length + metadata round-trip.
    expect(p.your_submission.content_length).toBe('short'.length)
    expect(p.your_submission.content_excerpt).toBe('short')
    expect(p.your_submission.metadata_received).toMatchObject({ category: 'nope', source: 'nope' })
  })
})

describe('Stage 1.5 — the DLP/PII gate (assertNoPii + validateAndRoute)', () => {
  it('passes clean content (no PiiDetectedError)', async () => {
    __setDlpClient(stubDlp(CLEAN_SCAN))
    await expect(assertNoPii(GOOD_CONTENT)).resolves.toBeUndefined()
  })

  it('throws PiiDetectedError when the sidecar finds PII (redaction-safe payload)', async () => {
    __setDlpClient(stubDlp({ pii: [{ entity_type: 'US_SSN', start: 0, end: 11, score: 0.9 }], secrets: [], block: true }))
    await expect(assertNoPii(GOOD_CONTENT)).rejects.toBeInstanceOf(PiiDetectedError)
    try {
      await assertNoPii(GOOD_CONTENT)
    } catch (e) {
      const err = e as PiiDetectedError
      expect(err.payload.error).toBe('pii_detected')
      expect(err.payload.findings[0].finding_type).toBe('US_SSN')
      // The raw content/value must never be echoed in the payload.
      expect(JSON.stringify(err.payload)).not.toContain(GOOD_CONTENT)
    }
  })

  it('throws PiiDetectedError when the sidecar finds a secret', async () => {
    __setDlpClient(stubDlp({ pii: [], secrets: [{ rule_id: 'aws-access-token', description: 'AWS Access Token' }], block: true }))
    await expect(assertNoPii('AKIA...')).rejects.toBeInstanceOf(PiiDetectedError)
  })

  it('FAILS CLOSED: a scanner error blocks the write (PiiDetectedError)', async () => {
    __setDlpClient({ scan: async () => { throw new Error('ECONNREFUSED') } })
    await expect(assertNoPii(GOOD_CONTENT)).rejects.toBeInstanceOf(PiiDetectedError)
  })

  it('validateAndRoute rejects PII BEFORE the LLM runs (no Stage-2 call)', async () => {
    let llmCalled = false
    __setExtractionLLM({ classify: async () => { llmCalled = true; return { outcome: 'accept' } } })
    __setDlpClient(stubDlp({ pii: [{ entity_type: 'CREDIT_CARD', start: 0, end: 16, score: 0.95 }], secrets: [], block: true }))
    await expect(validateAndRoute(GOOD_CONTENT, GOOD_META)).rejects.toBeInstanceOf(PiiDetectedError)
    expect(llmCalled, 'the LLM must NOT be called once PII is detected').toBe(false)
  })
})
