/**
 * MODEL/DIM GUARD — the client-managed embeddings precomputed-vector consistency invariant.
 *
 * server-managed embeddings: the server embeds with the pinned model BY CONSTRUCTION, so this is a
 * cheap assertion. client-managed embeddings (client-bridge): the api receives a PRECOMPUTED vector
 * from a laptop bridge with a declared model_id/dim. Reject any vector whose
 * declared pin ≠ the collection's active pin — that consistency is what makes
 * every bridge's vectors mutually comparable across the shared corpus.
 *
 * Wire at the api write handler: assertActivePin({modelId,dim,vector}, activePin)
 * → on throw, map ModelDimMismatchError to a 422 with the actionable message.
 */
import type { ActivePin } from '../types/index.ts'

export class ModelDimMismatchError extends Error {
  override readonly name = 'ModelDimMismatchError'
  readonly code = 'embedding_pin_mismatch'
  constructor(
    readonly declared: { modelId: string; dim: number },
    readonly active: { modelId: string; dim: number },
  ) {
    super(
      `Precomputed vector declares model=${declared.modelId} dim=${declared.dim}, ` +
        `but the active collection pin is model=${active.modelId} dim=${active.dim}. ` +
        `client-managed embeddings bridges MUST embed with the pinned model — re-pull "${active.modelId}" in ` +
        `your local Ollama (the admin set this in System Settings), or wait if a model ` +
        `switch is in progress.`,
    )
  }
}

/** Called on EVERY client-managed embeddings precomputed-vector write, before upsert. */
export function assertActivePin(
  declared: { modelId: string; dim: number; vector: number[] },
  active: ActivePin,
): void {
  if (declared.modelId !== active.modelId || declared.dim !== active.dim) {
    throw new ModelDimMismatchError(
      { modelId: declared.modelId, dim: declared.dim },
      active,
    )
  }
  // Defense in depth: correct model_id but wrong-length vector is still poison.
  if (declared.vector.length !== active.dim) {
    throw new ModelDimMismatchError(
      { modelId: declared.modelId, dim: declared.vector.length },
      active,
    )
  }
}
