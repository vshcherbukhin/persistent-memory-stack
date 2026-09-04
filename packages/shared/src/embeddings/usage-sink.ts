/**
 * Embedding usage SINK — a DI seam that keeps @pm/shared Prisma-free.
 *
 * @pm/shared cannot import @pm/db (it must stay vendor-/Prisma-neutral), so the
 * embedders can't record usage directly. Instead they `emitEmbedUsage(...)`; the
 * HOST process (api/worker boot) calls `setEmbedUsageSink(...)` to forward to the
 * @pm/db recorder. When no sink is set (e.g. the MCP, which has no DB), emit is a
 * no-op — zero overhead, no coupling.
 */
export interface EmbedUsageEvent {
  provider: string
  model: string
  /** Token estimate for the embedded input (embeddings have no output tokens). */
  tokens: number
}

type Sink = (e: EmbedUsageEvent) => void

let sink: Sink | null = null

/** Wire (or clear) the usage sink. Called once at host boot. */
export function setEmbedUsageSink(fn: Sink | null): void {
  sink = fn
}

/** Emit a usage event to the sink if one is set. Never throws into embedding. */
export function emitEmbedUsage(e: EmbedUsageEvent): void {
  try {
    sink?.(e)
  } catch {
    /* a broken sink must never break an embedding call */
  }
}

/** Rough token estimate from input text length (~4 chars/token). Pure. */
export function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4)
}
