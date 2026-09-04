/**
 * Resolve the embedding config from EMBED_* env (fail-fast at boot).
 *
 * EMBED_PROVIDER is the CONCRETE backend (ollama | voyage | openai). It is a
 * DIFFERENT axis from EMBEDDING_MODE (server | client-bridge = server-managed/client-managed embeddings), which
 * the Qdrant write path consumes — do not conflate them. See the reconciliation
 * note in packages/shared/README.md and the .env template.
 */
import type { ProviderName } from '../types/index.ts'
import { cfgErr } from '../types/index.ts'
import { validateModelDim } from './registry.ts'

export interface EmbedConfig {
  provider: ProviderName
  model: string
  dim: number
  ollamaUrl: string
  voyageApiKey?: string
  openaiApiKey?: string
  /** Per-batch input count. Default per provider. */
  batchSize: number
  /** Retries on transient (429/5xx/timeout/network) failures. */
  maxRetries: number
  /** Per-request abort deadline (ms). */
  requestTimeoutMs: number
}

const PROVIDERS: readonly ProviderName[] = ['ollama', 'voyage', 'openai']

function defaultBatch(provider: ProviderName): number {
  switch (provider) {
    case 'ollama':
      return 16 // CPU-bound, single model instance
    case 'voyage':
      return 128 // API caps input array at 1000
    case 'openai':
      return 256
  }
}

export function resolveEmbedConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmbedConfig {
  const providerRaw = env.EMBED_PROVIDER ?? 'ollama'
  if (!PROVIDERS.includes(providerRaw as ProviderName)) {
    throw cfgErr(
      'ollama',
      env.EMBED_MODEL ?? '(unset)',
      `EMBED_PROVIDER="${providerRaw}" is invalid. The concrete-provider enum is ${PROVIDERS.join(' | ')}. ` +
        `(The server-side vs client-bridge choice is EMBEDDING_MODE, a separate var.)`,
    )
  }
  const provider = providerRaw as ProviderName
  const model = env.EMBED_MODEL ?? 'qwen3-embedding:4b'
  const dim = Number(env.EMBED_DIM ?? 2560)
  if (!Number.isInteger(dim) || dim <= 0) {
    throw cfgErr(provider, model, `EMBED_DIM must be a positive integer, got "${env.EMBED_DIM}".`)
  }
  validateModelDim(provider, model, dim) // throws config error on mismatch

  if (provider === 'voyage' && !env.VOYAGE_API_KEY) {
    throw cfgErr(provider, model, 'EMBED_PROVIDER=voyage requires VOYAGE_API_KEY.')
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    throw cfgErr(provider, model, 'EMBED_PROVIDER=openai requires OPENAI_API_KEY.')
  }

  return {
    provider,
    model,
    dim,
    ollamaUrl: env.OLLAMA_URL ?? 'http://host.docker.internal:11434',
    voyageApiKey: env.VOYAGE_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    batchSize: Number(env.EMBED_BATCH_SIZE ?? defaultBatch(provider)),
    maxRetries: Number(env.EMBED_MAX_RETRIES ?? 4),
    requestTimeoutMs: Number(env.EMBED_TIMEOUT_MS ?? 30000),
  }
}
