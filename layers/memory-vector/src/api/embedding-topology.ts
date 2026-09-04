import type { EmbeddingMode as DbEmbeddingMode } from '@pm/db'
import type { EmbeddingMode as WireEmbeddingMode, EmbeddingTopology } from '@pm/shared'

/** DB enum -> wire alias. `client_bridge` cannot contain a hyphen in Prisma. */
export function dbModeToWire(mode: DbEmbeddingMode): WireEmbeddingMode {
  return mode === 'client_bridge' ? 'client-bridge' : 'server'
}

/** Wire alias -> DB enum. Kept for migration compatibility. */
export function wireModeToDb(mode: WireEmbeddingMode): DbEmbeddingMode {
  return mode === 'client-bridge' ? 'client_bridge' : 'server'
}

export function legacyModeToEmbeddingTopology(mode: WireEmbeddingMode): EmbeddingTopology {
  return mode === 'client-bridge' ? 'client-managed-embeddings' : 'server-managed-embeddings'
}

export function embeddingTopologyToLegacyMode(topology: EmbeddingTopology): WireEmbeddingMode {
  return topology === 'client-managed-embeddings' ? 'client-bridge' : 'server'
}
