/**
 * persistent-memory-api — model price map for usage cost (read-time).
 *
 * $/Mtok per model. Edit here to retune (cost is computed at READ time in the
 * aggregation, so changes apply to ALL history). Local Ollama/embedding models
 * are $0 (self-hosted). Unknown models → cost 0 + `estimated:true` so the UI
 * badges them (never shows a real-but-unpriced model as "free"). A DB-backed,
 * admin-editable price table is a future enhancement.
 */
export interface ModelPrice {
  inPerMtok: number
  outPerMtok: number
}

export const PRICES: Record<string, ModelPrice> = {
  // Extraction / Shape-gate LLMs (June 2026 list pricing)
  'claude-sonnet-4-6': { inPerMtok: 3, outPerMtok: 15 },
  'claude-haiku-4-5-20251001': { inPerMtok: 1, outPerMtok: 5 },
  'claude-haiku-4-5': { inPerMtok: 1, outPerMtok: 5 },
  'gpt-4o': { inPerMtok: 2.5, outPerMtok: 10 },
  // Local embedding models — self-hosted, known-free.
  'qwen3-embedding:0.6b': { inPerMtok: 0, outPerMtok: 0 },
  'qwen3-embedding:4b': { inPerMtok: 0, outPerMtok: 0 },
  'qwen3-embedding:8b': { inPerMtok: 0, outPerMtok: 0 },
  'nomic-embed-text': { inPerMtok: 0, outPerMtok: 0 },
}

/** Cost in USD for the token counts. Unknown model → 0 + estimated:true. */
export function costFor(
  model: string,
  tokensIn: number,
  tokensOut: number,
): { cost: number; estimated: boolean } {
  const p = PRICES[model]
  if (!p) return { cost: 0, estimated: true }
  return { cost: (tokensIn / 1e6) * p.inPerMtok + (tokensOut / 1e6) * p.outPerMtok, estimated: false }
}
