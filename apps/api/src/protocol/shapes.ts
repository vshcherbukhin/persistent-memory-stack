/**
 * persistent-memory-api — Shape A–E protocol constants (Phase 7).
 *
 * Ports the closed taxonomies + actionable-reject guidance from
 * mem0-stack/lib/validation.py to TS. These are the SOURCE OF TRUTH the
 * reject payload echoes so an agent can self-correct WITHOUT fetching any
 * server-side file. Keep in lockstep with prompts/fact-extraction.md (the
 * prompt the LLM verdict runs against).
 *
 * Two deliberate IMPROVEMENTS over the Python source:
 *   • SHAPE_TEMPLATES adds the Shape **E** skeleton (validation.py only defined
 *     A–D, though the prompt + global mem0 rules define E). The TS payload is
 *     complete.
 *   • ENTITY_FORMAT_GUIDANCE.common_prefixes_examples + non_examples extended to
 *     match the prompt's fuller illustrative list (flag_, etc.).
 *
 * `category` is the FREE-FORM open-vocabulary String stored on Memory.category;
 * `MemoryShape` is the CLOSED enum stored on Memory.shape (A–E). They are
 * distinct columns with distinct purposes — never conflate them.
 */
import type { MemoryShape } from '@pm/db'

// ── Closed enums (small, stable taxonomies we own — kept closed server-side). ─
export const VALID_CATEGORIES = [
  'gotcha',
  'fix',
  'user-correction',
  'tool-gap',
  'prd',
  'migration-pattern',
  'data-constraint',
  'permission',
  'flag-state',
] as const
export type ValidCategory = (typeof VALID_CATEGORIES)[number]

export const VALID_SOURCES = [
  'gotcha-discovered',
  'user-correction',
  'postmortem',
  'confluence',
  'test-failure',
  'heal-cycle',
] as const
export type ValidSource = (typeof VALID_SOURCES)[number]

// ── Provenance / multi-tier derivation (Phase 9, #11) ──────────────────────────
// The write route stamps these server-side from the source/category (the agent can
// override tier/provenance/confidence via the MCP metadata). These DB-enum string
// values mirror prisma `MemoryTier` / `SourceProvenance`.
export type MemoryTierValue = 'semantic' | 'episodic' | 'procedural' | 'working'
export type ProvenanceValue = 'human_verified' | 'api_return' | 'agent_inferred'

/** Map a write source → provenance. Human-authored sources are trusted; agent-derived
 *  sources (gotcha-discovered, test-failure) and unknown/absent default to the
 *  least-trusted agent_inferred (down-ranked by the rerank provenance gate). */
export function deriveProvenance(source: string | undefined): ProvenanceValue {
  switch (source) {
    case 'user-correction':
    case 'postmortem':
    case 'confluence':
    case 'heal-cycle':
      return 'human_verified'
    default:
      return 'agent_inferred'
  }
}

/** Baseline confidence per provenance — used when the LLM emits no verbal confidence. */
export function defaultConfidence(provenance: ProvenanceValue): number {
  switch (provenance) {
    case 'human_verified':
      return 0.9
    case 'api_return':
      return 0.8
    case 'agent_inferred':
      return 0.6
  }
}

/** Derive the tier (default semantic; agent may override via the MCP `tier` param).
 *  Category wins: every current QA category is a durable FACT (semantic) or how-to
 *  (procedural), so we do NOT auto-map sessionId→episodic — that would wrongly age
 *  out a session-discovered gotcha (which is still a durable fact). Recency-decay
 *  already handles freshness independent of tier. `hasSession` is the last-resort
 *  fallback only for an unknown category. */
export function deriveTier(opts: { category?: string; hasSession?: boolean }): MemoryTierValue {
  const c = opts.category
  if (c === 'migration-pattern') return 'procedural'
  if (c && (VALID_CATEGORIES as readonly string[]).includes(c)) return 'semantic'
  if (opts.hasSession) return 'episodic'
  return 'semantic'
}

/**
 * The `<type>_<specific_name>` token SHAPE check (first deterministic gate).
 * Lowercase snake_case: a lowercase-letter-led prefix, an underscore, then a
 * lowercase/digit/underscore suffix. Quality (generic suffix, leading article,
 * etc.) is delegated to the LLM — this regex only proves a token of the right
 * SHAPE exists somewhere in content. Mirrors validation.py ENTITY_TOKEN_REGEX.
 */
export const ENTITY_TOKEN_REGEX = /[a-z][a-z0-9]*_[a-z0-9_]+/

/** Excerpt cap for the reject payload's your_submission echo (port _EXCERPT_LIMIT). */
export const EXCERPT_LIMIT = 300

/**
 * Shape skeletons returned verbatim in every reject payload. A/B/C/D ported
 * from validation.py SHAPE_TEMPLATES; E added (the deliberate completeness fix).
 */
export const SHAPE_TEMPLATES = {
  A: '[<entity>] <symptom>. Root cause: <why>. Fix: <what>. Prevention: <how>.',
  B: '[<task-context>] Tried <wrong approach>, because <reason>. User said <correction>. Correct approach: <what works>. Key insight: <broader learning>.',
  C: '[tool_<tool_name>] <what was queried> returns/fails <result> but does NOT include <missing>. Workaround: <what worked>. Useful for: <when this gap matters>.',
  D: 'Free-form content; requires metadata.source="confluence" plus non-empty metadata.pageId and metadata.confluenceUrl. Used for PRD chunks.',
  E: '[<entity>] <fact in one line>. Why it matters: <what a fresh session would do wrong without this>.',
} as const

/** Entity-format guidance — ports validation.py ENTITY_FORMAT_GUIDANCE, extended. */
export const ENTITY_FORMAT_GUIDANCE = {
  pattern: '<type>_<specific_name>',
  shape_regex: '\\b[a-z][a-z0-9]*_[a-z0-9_]+\\b',
  constraints: [
    'lowercase snake_case throughout (no camelCase, no PascalCase, no hyphens)',
    'type prefix is a domain noun describing what kind of thing this is ' +
      '(page_, modal_, component_, builder_, tool_, test_, epic_, perm_, ' +
      'prd_, skill_, flag_ are common; new domains may introduce new prefixes ' +
      'like agency_, endpoint_, fixture_, step_, field_, bug_)',
    'specific name follows the prefix — never generic. ' +
      '`gotham_agency` not `agency`. `test_TC_6596` not `the_test`. ' +
      '`page_my_organization` not `page_thing`.',
    'must appear VERBATIM (case-sensitive, exact punctuation) both in ' +
      'metadata.entities[] AND somewhere in content',
  ],
  common_prefixes_examples: [
    'page_<route>',
    'modal_<modal_name>',
    'component_<component_name>',
    'builder_<entity>',
    'tool_<mcp_or_cli_tool>',
    'test_<test_id_or_class>',
    'epic_<epic_name>',
    'perm_<permission_name>',
    'prd_<feature>',
    'skill_<skill_name>',
    'flag_<flag_name>',
  ],
  non_examples_with_reason: {
    the_test: 'leading article is not a domain type prefix',
    function_name: 'programming term, not a domain type',
    MyComponent: 'PascalCase, missing snake_case prefix',
    modal: 'missing the specific suffix',
    'component-name': 'hyphen instead of underscore separator',
  },
} as const

/**
 * Map a validator outcome + metadata.category + content markers → MemoryShape.
 *
 *   • restructure ALWAYS produces canonical Shape A (gotcha_fix) — prompt §6.
 *   • accept → derive from category first, then content markers (prompt §1/§4):
 *       category ∈ {gotcha,fix}  → gotcha_fix (A)
 *       category = user-correction → user_correction (B)
 *       category = tool-gap        → tool_gap (C)
 *       category = prd             → prd (D)
 *       else (atomic "Why it matters:" w/o Shape-A markers) → atomic (E),
 *       falling back to gotcha_fix when Shape-A markers are present.
 */
export function deriveShape(
  outcome: 'accept' | 'restructure',
  category: string,
  content: string,
): MemoryShape {
  if (outcome === 'restructure') return 'gotcha_fix'

  switch (category) {
    case 'gotcha':
    case 'fix':
      return 'gotcha_fix'
    case 'user-correction':
      return 'user_correction'
    case 'tool-gap':
      return 'tool_gap'
    case 'prd':
      return 'prd'
    default:
      break
  }

  // Marker-based fallback for the remaining open categories
  // (migration-pattern / data-constraint / permission / flag-state).
  const hasShapeA = /Root cause:/i.test(content) || /\bFix:/i.test(content)
  if (!hasShapeA && /Why it matters:/i.test(content)) return 'atomic'
  return 'gotcha_fix'
}
