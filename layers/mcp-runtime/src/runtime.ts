/**
 * Runtime resolution: read the EFFECTIVE embedding mode + active pin from the
 * API at startup, and (client-managed embeddings only) build the local Ollama bridge embedder.
 *
 * DO NOT trust the MCP's own EMBEDDING_MODE env — the mode is admin-toggleable at
 * runtime (P9 System Settings). The truth is GET /config: {embeddingMode,
 * activeModel, activeDim, activeVectorName}. We cache it for the process lifetime
 * (a stale pin mid-session surfaces as a 422 embedding_pin_mismatch telling the
 * agent to restart — cheaper than a /config round-trip per call).
 *
 * Client-managed embeddings build the embedder from the SERVER PIN (activeModel/activeDim), NOT the
 * laptop's EMBED_* env. Embedding with a different model produces incomparable
 * vectors and poisons the shared corpus; the env values are hints only and we
 * warn (to stderr) if they differ.
 */
import { makeEmbedderForPin, type EmbedKind } from '@pm/shared'
import type { ApiClient } from './api-client.ts'
import type { McpConfig } from './config.ts'
import { log } from './log.ts'

export type MemorySurface = 'personal' | 'shared'

export type MemoryApi = Pick<ApiClient, 'get' | 'post' | 'patch' | 'del' | 'delNoContent'>

export interface ServerConfig {
  embeddingMode: 'server' | 'client-bridge'
  activeModel: string
  activeDim: number
  activeVectorName: string
  deploymentMode: 'server' | 'local'
  mcpSessionIdleTimeoutSeconds?: number
}

export interface Runtime {
  mode: 'server' | 'client-bridge'
  deploymentMode: 'server' | 'local'
  pin: { modelId: string; dim: number }
  /** Streamable HTTP session idle timeout. Heartbeats do not extend this. */
  mcpSessionIdleTimeoutSeconds: number
  /** Non-null only in client-managed embeddings. Embeds locally with the SERVER-pinned model. */
  bridge: { embed(texts: string[], kind: EmbedKind): Promise<number[][]> } | null
  /**
   * Best-effort client-managed embedding observation. The API derives the observer
   * scope from the authenticated identity; the bridge never supplies a scope.
   */
  reportEmbeddingHealth?: (outcome: {
    ok: true
  } | {
    ok: false
    code: 'embedding_quota_exhausted' | 'embedding_provider_rate_limited' | 'embedding_provider_unavailable' | 'embedding_model_unavailable' | 'embedding_timeout'
  }) => Promise<void>
  /** Optional personal/shared routing contexts for memory tools. */
  memorySurfaces?: {
    defaultSurface: MemorySurface
    personal?: { api: MemoryApi; runtime: Runtime }
    shared?: { api: MemoryApi; runtime: Runtime }
  }
}

export async function resolveRuntime(api: ApiClient, cfg: McpConfig): Promise<Runtime> {
  const c = await api.get<ServerConfig>('/config')
  const mcpSessionIdleTimeoutSeconds = c.mcpSessionIdleTimeoutSeconds ?? 15 * 60

  if (c.embeddingMode === 'server') {
    // server-managed embeddings — the server embeds. The MCP sends text only; no local embedder.
    return {
      mode: 'server',
      deploymentMode: c.deploymentMode,
      pin: { modelId: c.activeModel, dim: c.activeDim },
      mcpSessionIdleTimeoutSeconds,
      bridge: null,
    }
  }

  // client-managed embeddings — the MCP is the embedding bridge. Build the embedder from the SERVER
  // PIN so every member's vectors are mutually comparable.
  if (cfg.EMBED_MODEL && cfg.EMBED_MODEL !== c.activeModel) {
    log.warn('bridge EMBED_MODEL differs from server pin; using the SERVER pin', {
      envModel: cfg.EMBED_MODEL,
      serverModel: c.activeModel,
    })
  }
  if (cfg.EMBED_DIM && cfg.EMBED_DIM !== c.activeDim) {
    log.warn('bridge EMBED_DIM differs from server pin; using the SERVER pin', {
      envDim: cfg.EMBED_DIM,
      serverDim: c.activeDim,
    })
  }

  // makeEmbedderForPin validates the (model, dim) pair via the registry and
  // throws an actionable config error if the pin is unknown/incompatible (fail fast).
  const embedder = makeEmbedderForPin(c.activeModel, c.activeDim, {
    ...process.env,
    OLLAMA_URL: cfg.OLLAMA_URL,
    VOYAGE_API_KEY: cfg.VOYAGE_API_KEY,
    OPENAI_API_KEY: cfg.OPENAI_API_KEY,
    EMBED_BATCH_SIZE: '16',
    EMBED_MAX_RETRIES: '4',
    EMBED_TIMEOUT_MS: String(cfg.PM_API_TIMEOUT_MS),
  })

  return {
    mode: 'client-bridge',
    deploymentMode: c.deploymentMode,
    pin: { modelId: c.activeModel, dim: c.activeDim },
    mcpSessionIdleTimeoutSeconds,
    bridge: {
      embed: async (texts, kind) => (await embedder.embed(texts, kind)).vectors,
    },
    reportEmbeddingHealth: async (outcome) => {
      await api.post('/embedding-health/observation', {
        provider: embedder.provider,
        model: c.activeModel,
        outcome,
      })
    },
  }
}
