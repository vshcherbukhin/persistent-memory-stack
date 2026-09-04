/**
 * Qdrant client factory. Thin wrapper over @qdrant/js-client-rest so callers
 * get one configured client from QDRANT_URL (+ optional API key).
 *
 * No module-level singleton (same reasoning as the embedder factory): api and
 * worker build their own at boot. `checkCompatibility:false` avoids a startup
 * version-handshake failure when the client minor trails the v1.18.2 server
 * (the REST contract we use — named vectors, is_tenant, query `using` — is
 * stable well before client 1.15).
 */
import { QdrantClient } from '@qdrant/js-client-rest'

export interface QdrantConfig {
  url: string
  apiKey?: string
}

export function makeQdrantClient(cfg: QdrantConfig): QdrantClient {
  return new QdrantClient({
    url: cfg.url,
    apiKey: cfg.apiKey,
    checkCompatibility: false,
  })
}

export function resolveQdrantConfig(env: NodeJS.ProcessEnv = process.env): QdrantConfig {
  const url = env.QDRANT_URL
  if (!url) {
    throw new Error('QDRANT_URL must be set to build the Qdrant client.')
  }
  return { url, apiKey: env.QDRANT_API_KEY }
}

export { QdrantClient }
