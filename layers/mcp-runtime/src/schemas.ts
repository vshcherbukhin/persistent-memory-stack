/**
 * Shared Zod fragments + tool-result helpers, reused across all tool modules.
 *
 * The SDK's registerTool takes a Zod RAW SHAPE (a {field: zod} map), NOT a
 * z.object(...). So these exports are either bare ZodTypes (composed into shapes)
 * or shape objects. Every field carries a clear .describe() with an example, per
 * mcp-builder conventions.
 */
import { z } from 'zod'
import type { ApiError } from './errors.ts'

// ── Scope (subtractive; validated server-side) ──────────────────────────────
export const Scope = z
  .union([z.enum(['own', 'granted']), z.array(z.string())])
  .optional()
  .describe(
    'Optional team scope. Omit = your team; "granted" = mounted teams as optional additional context. ' +
      'Or provide mounted team ids only. scope can only narrow, never widen. e.g. "own"',
  )

export const GraphProjects = z
  .array(z.string().min(1))
  .min(1)
  .max(20)
  .optional()
  .describe(
    'Explicit graph projects to recall together. Omit for the personal "general" project only. ' +
      'Use this only when the task needs a workspace picture across named projects. e.g. ["inventory-service", "customer-portal"]',
  )

// ── Project (the nudge field — REQUIRED on writes, deliberate classification) ─
export const ProjectField = z
  .string()
  .min(1)
  .describe(
    'REQUIRED. The project this belongs to. Name the real project you are working under — infer it ' +
      'from the cwd / git repo root (e.g. "inventory-service", "customer-portal"). For a non-project ' +
      'or aside chat with no repo context, pass exactly "general". Do NOT guess a vague label — ' +
      'classify deliberately so memories are findable later. e.g. "inventory-service"',
  )

// ── Session id (server mints one per MCP process if omitted) ─────────────────
export const SessionId = z
  .string()
  .optional()
  .describe(
    'Optional conversation/session id. The server mints one per MCP process if omitted; pass to ' +
      'override (e.g. to group a multi-process investigation). e.g. "sess-2026-06-24-auth-refactor"',
  )

// ── Memory metadata (matches the API's Metadata; .strict() rejects unknowns) ──
export const MetadataShape = {
  category: z
    .enum([
      'gotcha',
      'fix',
      'user-correction',
      'tool-gap',
      'prd',
      'migration-pattern',
      'data-constraint',
      'permission',
      'flag-state',
    ])
    .describe('Memory category (the Shape gate keys off this). e.g. "gotcha"'),
  entities: z
    .array(z.string())
    .min(1)
    .describe(
      '>=1 lowercase snake_case <type>_<name> entities; EACH must appear VERBATIM (case-sensitive) ' +
        'in content. e.g. ["component_AuthGuard","perm_read_write"]',
    ),
  source: z
    .enum([
      'gotcha-discovered',
      'user-correction',
      'postmortem',
      'confluence',
      'test-failure',
      'heal-cycle',
    ])
    .describe('What triggered the save. e.g. "gotcha-discovered"'),
  severity: z.enum(['high', 'medium', 'low']).optional().describe('Optional severity. e.g. "high"'),
  epic: z.string().optional().describe('Optional epic scope string.'),
  feature: z.string().optional().describe('Optional feature scope string.'),
  pageId: z.string().optional().describe('Confluence page id — REQUIRED when category="prd".'),
  confluenceUrl: z.string().optional().describe('Confluence URL — REQUIRED when category="prd".'),
  // Phase 9: the agent may classify the memory tier. provenance + confidence are
  // SERVER-determined (from source + the gate LLM) and cannot be set here.
  tier: z
    .enum(['semantic', 'episodic', 'procedural', 'working'])
    .optional()
    .describe(
      'Optional memory tier. semantic=durable fact (default), procedural=how-to/workflow, ' +
        'episodic=session event, working=transient. Most QA memories are semantic.',
    ),
}
export const Metadata = z.object(MetadataShape).strict()

// ── A memory result row (MUST mirror the API's ResultRow in api/src/routes/memories.ts) ──
// The SDK validates structuredContent with additionalProperties:false, so any field the
// api returns MUST be declared here or the tool errors. The P9 trust fields are populated
// by SEMANTIC search (search_memories) and omitted by the non-vector list/get endpoints —
// hence optional (present → surfaced; absent → still valid).
export const ResultRowShape = {
  id: z.string(),
  content: z.string(),
  category: z.string(),
  shape: z.string(),
  entities: z.array(z.string()),
  project: z.string(),
  sessionId: z.string().nullable(),
  createdById: z.string().nullable(),
  score: z.number().optional(),
  sourceTeam: z.string(),
  isOwnTeam: z.boolean(),
  createdAt: z.string(),
  recordUpdatedAt: z.string(),
  memoryTier: z.string().optional(),
  sourceProvenance: z.string().optional(),
  confidence: z.number().optional(),
}
export const ResultRow = z.object(ResultRowShape)

// ── A Graphiti fact edge (the API's FactEdgeSchema) ──────────────────────────
export const FactEdgeShape = {
  uuid: z.string(),
  name: z.string().nullable(),
  fact: z.string().nullable(),
  source_node_uuid: z.string().nullable(),
  target_node_uuid: z.string().nullable(),
  source_name: z.string().nullable(),
  target_name: z.string().nullable(),
  group_id: z.string().nullable(),
  valid_at: z.string().nullable(),
  invalid_at: z.string().nullable(),
  project: z.string(),
  surface: z.enum(['personal', 'shared']),
  relation: z.enum(['own', 'granted']),
}
export const FactEdge = z.object(FactEdgeShape)

export const TimelineEntry = FactEdge.extend({ status: z.enum(['valid', 'invalid']) })
export const Contradiction = z.object({
  superseded: FactEdge,
  superseded_by: FactEdge.nullable(),
})

export const ALWAYS_LOAD_META = {
  'anthropic/alwaysLoad': true,
  'openai/alwaysLoad': true,
} as const

// ── Standard tool-result envelopes ───────────────────────────────────────────
export type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Success: BOTH a one-line text summary AND structuredContent. */
export function ok(summary: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: data }
}

/** Error: actionable text, isError:true. Optionally carry structured detail. */
export function toolError(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return structuredContent
    ? { content: [{ type: 'text', text }], structuredContent, isError: true }
    : { content: [{ type: 'text', text }], isError: true }
}

/**
 * Refuse malformed graph evidence before the MCP SDK attempts output-schema
 * validation. Provenance is API-derived authorization context; the MCP must
 * never fabricate it merely to make a graph response parse.
 */
export function graphResponseContractError(toolName: string, facts: unknown[]): ToolResult | undefined {
  const malformed = facts.filter((fact) => {
    if (!fact || typeof fact !== 'object') return true
    const candidate = fact as Record<string, unknown>
    return typeof candidate.project !== 'string' ||
      (candidate.surface !== 'personal' && candidate.surface !== 'shared') ||
      (candidate.relation !== 'own' && candidate.relation !== 'granted')
  })
  if (malformed.length === 0) return undefined

  return graphContractRecovery(toolName, `${malformed.length} graph fact${malformed.length === 1 ? '' : 's'} without required project/surface/relation provenance`)
}

/** Validate contradiction pairs before their nested facts reach an MCP output schema. */
export function graphContradictionResponseContractError(toolName: string, contradictions: unknown[]): ToolResult | undefined {
  const facts: unknown[] = []
  let malformedPairs = 0
  for (const contradiction of contradictions) {
    if (!contradiction || typeof contradiction !== 'object') {
      malformedPairs += 1
      continue
    }
    const pair = contradiction as Record<string, unknown>
    const hasSuccessor = Object.prototype.hasOwnProperty.call(pair, 'superseded_by')
    if (!pair.superseded || typeof pair.superseded !== 'object' || !hasSuccessor ||
      (pair.superseded_by !== null && typeof pair.superseded_by !== 'object')) {
      malformedPairs += 1
      continue
    }
    facts.push(pair.superseded)
    if (pair.superseded_by) facts.push(pair.superseded_by)
  }
  if (malformedPairs > 0) {
    return graphContractRecovery(toolName, `${malformedPairs} malformed contradiction pair${malformedPairs === 1 ? '' : 's'}`)
  }
  return graphResponseContractError(toolName, facts)
}

function graphContractRecovery(toolName: string, detail: string): ToolResult {
  return toolError(
    `Persistent Memory recovery required [graph_response_contract_invalid] — ${toolName} received ${detail}. ` +
      'Your request arguments are valid; do not change project, projects, scope, or surface to repair this response. ' +
      `Retry the same ${toolName} call once with the same query and project selection. If it repeats, do not treat required recall as completed or silently substitute a bare search. ` +
      'Tell the user that Persistent Memory returned graph_response_contract_invalid and continue only with independently verified current evidence.',
  )
}

/** Map a caught ApiError → a ToolResult (422 carries the RejectPayload). */
export function fromApiError(err: ApiError): ToolResult {
  const reject = err.rejectPayload()
  if (reject) return toolError(err.toAgentText(), { reject })
  return toolError(err.toAgentText())
}

/** The project nudge ToolError — fired client-side before any API call. */
export function projectNudge(toolName: string): ToolResult {
  return toolError(
    `\`project\` is required for ${toolName}. Name the project you are working under (infer it from ` +
      'the cwd / git repo root, e.g. the repo folder name) — or pass exactly "general" for a ' +
      'non-project/aside chat. The API would default to "general", but this MCP enforces a ' +
      'deliberate classification so memories are findable later.',
  )
}

// Standard annotation presets (openWorldHint is always true — external API).
export const RO_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const

export const WRITE_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const
