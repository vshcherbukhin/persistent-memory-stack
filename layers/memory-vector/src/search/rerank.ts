/**
 * persistent-memory-api — memory search rerank (Phase 9, #11).
 *
 * The canonical Generative-Agents / CrewAI retrieval formula adapted to this stack:
 *
 *   score = (α·relevance + β·recency-decay + γ·importance) · trust
 *
 * where `trust` is the STRICT-PROVENANCE GATE — confidence is NEVER used on its own.
 * Provenance always discounts confidence, so a low-confidence, agent-inferred, stale
 * memory ranks below a human-sourced, fresh, relevant one at equal raw relevance.
 *
 * Pure + dependency-free → unit-tested without a DB. merge.ts feeds it the hydrated
 * rows + the (env-tunable) weights and sorts by the returned score.
 */

export type ProvenanceValue = 'human_verified' | 'api_return' | 'agent_inferred'

export interface RerankWeights {
  alpha: number // relevance
  beta: number // recency
  gamma: number // importance
  halfLifeDays: number // recency-decay half-life
}

export const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
  alpha: 1.0, // relevance dominates (Generative-Agents uses α=1)
  beta: 0.3,
  gamma: 0.2,
  halfLifeDays: 30, // ~mem0's 7-day was too aggressive for a QA fact store; 30d is gentler
}

/** Trust discount per provenance. Confidence is never trusted on its own. */
const PROVENANCE_FACTOR: Record<ProvenanceValue, number> = {
  human_verified: 1.0,
  api_return: 0.9,
  agent_inferred: 0.75,
}

/** Importance by Shape — a durable gotcha/fix outranks a loose atomic note. */
const SHAPE_IMPORTANCE: Record<string, number> = {
  gotcha_fix: 1.0,
  user_correction: 0.95,
  tool_gap: 0.85,
  prd: 0.8,
  atomic: 0.6,
}

export interface RerankInput {
  score: number // Qdrant cosine relevance (≈0..1)
  createdAt: string // ISO
  lastAccessedAt: string | null // ISO — reinforcement resets recency
  confidence: number // 0..1
  sourceProvenance: ProvenanceValue
  shape: string
}

/** Recency decay 0.5^(age/halfLife), measured from last access (reinforcement) or
 *  creation. 1.0 when fresh, 0.5 at one half-life, → 0 as it ages. */
export function recencyDecay(
  createdAt: string,
  lastAccessedAt: string | null,
  nowMs: number,
  halfLifeDays: number,
): number {
  const ref = Date.parse(lastAccessedAt ?? createdAt)
  if (!Number.isFinite(ref)) return 0
  const ageDays = Math.max(0, (nowMs - ref) / 86_400_000)
  return Math.pow(0.5, ageDays / Math.max(1e-6, halfLifeDays))
}

export function importanceOf(shape: string): number {
  return SHAPE_IMPORTANCE[shape] ?? 0.6
}

/** The strict-provenance gate: provenance × confidence, never confidence alone. */
export function trustFactor(provenance: ProvenanceValue, confidence: number): number {
  const c = Math.min(1, Math.max(0, confidence))
  return (PROVENANCE_FACTOR[provenance] ?? 0.75) * c
}

/** The composite rerank score for one memory. */
export function rerankScore(m: RerankInput, w: RerankWeights, nowMs: number): number {
  const relevance = m.score
  const recency = recencyDecay(m.createdAt, m.lastAccessedAt, nowMs, w.halfLifeDays)
  const importance = importanceOf(m.shape)
  const base = w.alpha * relevance + w.beta * recency + w.gamma * importance
  return base * trustFactor(m.sourceProvenance, m.confidence)
}
