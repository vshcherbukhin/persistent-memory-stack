/**
 * @pm/shared — common types + enums shared across embeddings, qdrant, and switch.
 *
 * Kept Prisma-free and DB-free on purpose (see the package description): callers
 * (api/worker/mcp) own Postgres and pass plain ids/strings in, get plain vectors
 * + Qdrant point ids back.
 */

/** Concrete embedder backend. NOT the same axis as EMBEDDING_MODE. */
export type ProviderName = 'ollama' | 'voyage' | 'openai'

/**
 * Embedding TOPOLOGY (server-managed embeddings vs client-managed embeddings), orthogonal to the provider:
 *   • server        — server-managed embeddings: the server runs the embedder (default).
 *   • client-bridge — client-managed embeddings: the server runs NO embedder; each member's MCP
 *                     embeds locally and uploads precomputed vectors.
 * Lives in EMBEDDING_MODE; consumed by the Qdrant write path's pin guard.
 */
export type EmbeddingMode = 'server' | 'client-bridge'

/** User-facing embedding topology names. The old `server` / `client-bridge`
 * strings remain as migration aliases at API boundaries only. */
export type EmbeddingTopology = 'server-managed-embeddings' | 'client-managed-embeddings'

/**
 * Asymmetric-retrieval hint. Only Voyage distinguishes these; ollama/openai
 * ignore it (symmetric models). Stored chunks/memories = 'document', the
 * search-time query = 'query'.
 */
export type EmbedKind = 'document' | 'query'

/** What a Qdrant point's source row is, mirrored from the Prisma SourceKind. */
export type VectorSourceKind = 'chunk' | 'memory'

/**
 * The collection's ACTIVE pinned embedder. Held by the CALLER (env in server-managed embeddings,
 * the P9 System Settings row at runtime) — Qdrant has no native "active named
 * vector" notion, so the pin is config, and the named vector key is derived
 * from it. shared never persists this; it is passed into every entry point.
 */
export interface ActivePin {
  modelId: string
  dim: number
  /** Derived: vectorName(modelId, dim) — the Qdrant named-vector key. */
  vectorName: string
}

/**
 * Typed, actionable error for every failure path in shared. `meta.kind`
 * classifies retriability + maps to an HTTP status at the api boundary.
 */
export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError'
  /** When the provider sent Retry-After, the parsed delay in ms (for backoff). */
  retryAfterMs?: number

  constructor(
    message: string,
    readonly meta: {
      provider: ProviderName
      model: string
      kind:
        | 'config' // bad EMBED_* env / unknown model / dim not supported
        | 'http' // non-2xx from the provider
        | 'shape' // response missing/garbled
        | 'dim_mismatch' // provider returned a different dim than pinned
        | 'auth' // 401/403 (missing/invalid key)
        | 'rate_limit' // 429 (exhausted retries)
        | 'timeout' // request aborted on the per-call deadline
        | 'network' // fetch threw (DNS/connection refused)
      status?: number
      cause?: unknown
    },
  ) {
    super(message)
  }
}

/** Convenience constructors used across the embedding modules. */
export function cfgErr(
  provider: ProviderName,
  model: string,
  message: string,
): EmbeddingError {
  return new EmbeddingError(message, { provider, model, kind: 'config' })
}

export function shapeErr(
  provider: ProviderName,
  model: string,
  message: string,
): EmbeddingError {
  return new EmbeddingError(message, { provider, model, kind: 'shape' })
}
