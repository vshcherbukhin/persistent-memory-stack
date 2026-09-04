/**
 * persistent-memory-api — embedding + Qdrant services (Phase 5 wiring).
 *
 * Builds, at boot, the singletons the data-plane will use in P6/P7:
 *   • embedder   — the server-managed server-side embedder (EMBED_* env), or null when
 *                  EMBEDDING_MODE=client-bridge (client-managed embeddings: the server runs NO
 *                  embedder; the MCP bridge supplies precomputed vectors and the
 *                  api enforces the pin via assertActivePin).
 *   • qdrant     — the @qdrant/js-client-rest client (QDRANT_URL).
 *   • activePin  — the collection's pinned (model, dim) + derived named-vector
 *                  key, derived here once at boot from EMBED_MODEL/EMBED_DIM.
 *                  P9 added a runtime override path: the admin-toggleable
 *                  SystemSettings singleton is read by GET /config (via
 *                  services/settings.ts → getEffectiveSettings), falling back to
 *                  this env-derived boot pin when no row exists. This module
 *                  itself stays boot-const; a model/dim change needs a re-embed
 *                  migration + restart (see routes/dashboard/settings.ts).
 *
 * All of this lives in @pm/shared (the reusable core) — this module only resolves
 * config and holds the instances. shared is Prisma-free; the api owns the DB and
 * passes team ids / row ids into shared on the write/search paths (P6/P7).
 */
import {
  type Embedder,
  type EmbeddingMode,
  makeEmbedderFromEnv,
  makeEmbedderForPin,
  makeQdrantClient,
  resolveQdrantConfig,
  resolveEmbedConfig,
  makeActivePin,
  type ActivePin,
  QdrantClient,
  setEmbedUsageSink,
} from '@pm/shared'
import { recordUsageFireAndForget } from '@pm/db'

// Forward every embedding call's token estimate to the usage recorder
// (service='embeddings'). The sink is the @pm/shared → @pm/db bridge; recordUsage
// reads ownerPrisma at call time, so wiring it at module load is safe (it fires
// only when an embed actually happens, i.e. request-time, after initDb).
setEmbedUsageSink((e) =>
  recordUsageFireAndForget({ service: 'embeddings', model: e.model, tokensIn: e.tokens, tokensOut: 0 }),
)

const mode = (process.env.EMBEDDING_MODE ?? 'server') as EmbeddingMode

/**
 * The active pin is always derived from EMBED_MODEL/EMBED_DIM (server-managed embeddings) — and is
 * also the pin a client-managed bridge must match. resolveEmbedConfig validates the
 * (provider, model, dim) triple, so an invalid pin fails fast at boot.
 *
 * P10: `activePin` + `embedder` are exported `let`s (LIVE bindings), not consts.
 * The model-switch driver flips them in-process via applyActivePin() at the flip
 * step, so every data-plane handler that reads `activePin`/`embedder` at call time
 * picks up the new pin with NO restart. (Single-instance api: an in-process flip
 * suffices; the WORKER — a separate process — polls SystemSettings to refresh.)
 */
const embedCfg = resolveEmbedConfig()
export let activePin: ActivePin = makeActivePin(embedCfg.model, embedCfg.dim)

/** server-managed embeddings → a server embedder; client-managed embeddings → null (bridge supplies vectors). */
export let embedder: Embedder | null =
  mode === 'server' ? makeEmbedderFromEnv() : null

/**
 * Flip the live pin (+ rebuild the server-managed embedder) to a new (model, dim). Called
 * by the model-switch driver at the flip step and idempotent-safe (a no-op when
 * the pin already matches). client-managed embeddings has no server embedder, so `embedder` stays
 * null. Throws (registry config error) if the model/dim is invalid — the caller
 * validated it before reaching here, so this is defense in depth.
 */
export function applyActivePin(model: string, dim: number): void {
  if (activePin.modelId === model && activePin.dim === dim) return
  activePin = makeActivePin(model, dim)
  if (mode === 'server') embedder = makeEmbedderForPin(model, dim)
}

/** The Qdrant client (always present — both modes read/write Qdrant). */
export const qdrant: QdrantClient = makeQdrantClient(resolveQdrantConfig())

export const embeddingMode: EmbeddingMode = mode
