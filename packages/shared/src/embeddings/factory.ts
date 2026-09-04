/**
 * makeEmbedder(config) → Embedder. Validates the (provider, model, dim) triple
 * via the registry, then constructs the provider impl.
 *
 * NO module-level singleton: shared is imported by api/worker/mcp which resolve
 * config at THEIR boot (and a client-managed MCP may build a LOCAL embedder pointed at
 * the laptop's Ollama). The caller holds the instance. Build one at app boot
 * with `makeEmbedderFromEnv()`.
 */
import type { Embedder } from './embedder.ts'
import type { EmbedConfig } from './config.ts'
import { resolveEmbedConfig } from './config.ts'
import { validateModelDim, MODEL_REGISTRY } from './registry.ts'
import { OllamaEmbedder } from './ollama.ts'
import { VoyageEmbedder } from './voyage.ts'
import { OpenAIEmbedder } from './openai.ts'

export function makeEmbedder(cfg: EmbedConfig): Embedder {
  const spec = validateModelDim(cfg.provider, cfg.model, cfg.dim)
  switch (cfg.provider) {
    case 'ollama':
      return new OllamaEmbedder(cfg, spec)
    case 'voyage':
      return new VoyageEmbedder(cfg, spec)
    case 'openai':
      return new OpenAIEmbedder(cfg, spec)
  }
}

/** Convenience: resolve EMBED_* env then build. Use at app boot. */
export function makeEmbedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  return makeEmbedder(resolveEmbedConfig(env))
}

/**
 * Build an embedder for a SPECIFIC (model, dim) — the env supplies the transport
 * config (urls/keys/batch/retries/timeout) but the model/dim/provider come from
 * the registry, not EMBED_MODEL/EMBED_DIM. Used by the live-pin path (api
 * applyActivePin / worker refresher) and the model-switch driver's target
 * embedder, where the pin differs from the boot env. Throws the registry config
 * error if the model is unknown or the dim is unsupported (fail fast).
 */
export function makeEmbedderForPin(
  model: string,
  dim: number,
  env: NodeJS.ProcessEnv = process.env,
): Embedder {
  const spec = validateModelDim(MODEL_REGISTRY[model]?.provider ?? 'ollama', model, dim)
  const base = resolveEmbedConfig({ ...env, EMBED_PROVIDER: spec.provider, EMBED_MODEL: model, EMBED_DIM: String(dim) })
  return makeEmbedder(base)
}
