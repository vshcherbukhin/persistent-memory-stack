/**
 * Topology-aware embedding helpers shared by every vector tool.
 *
 *   • server-managed embeddings (server): the tool sends the raw `query`/`content` text; the SERVER
 *     embeds. These helpers return `undefined` extras (nothing to attach).
 *   • client-managed embeddings (client-bridge): the tool embeds locally via the runtime bridge and
 *     attaches a precomputed vector. For a SEARCH it sends `queryVector` (no
 *     `query`); for an ADD it sends `queryVector`+`embeddingModelId`+`embeddingDim`
 *     (the API's AddBody reuses the field name `queryVector` for the memory
 *     vector — a slight misnomer; do NOT invent a different name).
 *
 * A local-embedding failure (e.g. model not pulled) becomes an actionable
 * ToolError, not a throw — the OllamaEmbedder error already ends with the exact
 * `ollama pull <model>` guidance, which we surface verbatim.
 */
import { EmbeddingError, type EmbedKind } from '@pm/shared'
import type { Runtime } from './runtime.ts'

/** Returned to the caller so it can decide between sending text vs a vector. */
export type BridgeResult =
  | { ok: true; vector: number[] | null }
  | { ok: false; error: string }

type BridgeFailureCode =
  | 'embedding_quota_exhausted'
  | 'embedding_provider_rate_limited'
  | 'embedding_provider_unavailable'
  | 'embedding_model_unavailable'
  | 'embedding_timeout'

function report(rt: Runtime, outcome: Parameters<NonNullable<Runtime['reportEmbeddingHealth']>>[0]): void {
  // Health must never hold a memory operation hostage. The API persists only the
  // canonical code and derives the observer scope from the authenticated caller.
  void rt.reportEmbeddingHealth?.(outcome).catch(() => {})
}

function bridgeFailure(error: unknown): { code: BridgeFailureCode; message: string } {
  if (error instanceof EmbeddingError) {
    const status = error.meta.status
    if (status === 402 || /\b(quota|tokens?|credits?|billing|budget)\b/i.test(error.message)) {
      return { code: 'embedding_quota_exhausted', message: 'Local embedding is out of tokens.' }
    }
    if (error.meta.kind === 'rate_limit' || status === 429) {
      return { code: 'embedding_provider_rate_limited', message: 'Local embedding provider is rate-limited. Retry shortly.' }
    }
    if (error.meta.kind === 'timeout') {
      return { code: 'embedding_timeout', message: 'Local embedding provider timed out. Retry shortly.' }
    }
    if (error.meta.kind === 'config' || error.meta.kind === 'dim_mismatch' || status === 404 || /\b(not pulled|model.+not found|unknown model)\b/i.test(error.message)) {
      return { code: 'embedding_model_unavailable', message: 'Local configured model is unavailable.' }
    }
  }
  return { code: 'embedding_provider_unavailable', message: 'Local embeddings are unavailable.' }
}

/**
 * Embed one text locally in client-managed embeddings; in server-managed embeddings return {vector:null} (the tool
 * keeps the text path). On a local-embedding failure return a friendly error
 * string the tool turns into a ToolError.
 */
export async function bridgeEmbed(
  rt: Runtime,
  text: string,
  kind: EmbedKind,
): Promise<BridgeResult> {
  if (rt.mode === 'server' || !rt.bridge) return { ok: true, vector: null }
  try {
    const [vector] = await rt.bridge.embed([text], kind)
    report(rt, { ok: true })
    return { ok: true, vector: vector ?? null }
  } catch (err) {
    const failure = bridgeFailure(err)
    report(rt, { ok: false, code: failure.code })
    return {
      ok: false,
      error:
        `Local embedding failed (client-managed embeddings / client-bridge). ${failure.message} ` +
        `The server-pinned model is "${rt.pin.modelId}" @ ${rt.pin.dim}-dim. ` +
        `Ensure your local Ollama is reachable (OLLAMA_URL) and run: ollama pull ${rt.pin.modelId}`,
    }
  }
}

/** The client-managed precomputed-vector fields for the ADD body (queryVector misnomer). */
export function addVectorFields(rt: Runtime, vector: number[]): Record<string, unknown> {
  return {
    queryVector: vector,
    embeddingModelId: rt.pin.modelId,
    embeddingDim: rt.pin.dim,
  }
}
