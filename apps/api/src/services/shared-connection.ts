import type { EmbeddingMode, EmbeddingTopology } from '@pm/shared'

export interface EmbeddingPin {
  model: string
  dim: number
}

export interface SharedRemotePin extends EmbeddingPin {
  topology: EmbeddingTopology
}

export interface CompatibilityDecision {
  ok: boolean
  requiresLocalEmbedding: boolean
  reason?: string
}

export function legacyModeToTopology(mode: EmbeddingMode): EmbeddingTopology {
  return mode === 'client-bridge' ? 'client-managed-embeddings' : 'server-managed-embeddings'
}

export function normalizeRemoteTopology(input: {
  embeddingTopology?: EmbeddingTopology
  embeddingMode?: EmbeddingMode
}): EmbeddingTopology {
  if (input.embeddingTopology) return input.embeddingTopology
  return legacyModeToTopology(input.embeddingMode ?? 'server')
}

export function decideSharedConnectionCompatibility(input: {
  local: EmbeddingPin
  remote: SharedRemotePin
}): CompatibilityDecision {
  if (input.remote.topology === 'server-managed-embeddings') {
    return { ok: true, requiresLocalEmbedding: false }
  }

  const matches =
    input.local.model === input.remote.model &&
    input.local.dim === input.remote.dim
  if (matches) return { ok: true, requiresLocalEmbedding: true }

  return {
    ok: false,
    requiresLocalEmbedding: true,
    reason:
      `Shared server uses client-managed embeddings and requires ${input.remote.model} @ ${input.remote.dim}. ` +
      `This local stack is configured for ${input.local.model} @ ${input.local.dim}.`,
  }
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

export function connectorEmailMatchesLocalProfile(
  localEmail: string | null | undefined,
  connectorEmail: string | null | undefined,
): boolean {
  const local = normalizeEmail(localEmail)
  const remote = normalizeEmail(connectorEmail)
  return Boolean(local && remote && local === remote)
}
