/**
 * Dimension/provider SWITCH TOOL — named-vector migration, zero downtime.
 *
 * The 5 steps (rollback = revert the active pointer; old vector survives until
 * the explicit drop, so every step before the drop is reversible):
 *
 *   1. ADD    — createVectorName: register the TARGET named vector slot. Schema
 *               only, NO data copy. Existing points have no value for it yet.
 *   2. DUAL-WRITE — a STATE FLAG (held by the caller, e.g. P9 System Settings),
 *               not a Qdrant call: while set, every new write embeds with BOTH
 *               models and writes both named vectors. The dim differs, so the
 *               target vector is embedded separately and written via
 *               updateVectors (see writeTargetVectors).
 *   3. RE-EMBED — scroll ALL points, re-embed each from its Postgres source text
 *               (via the caller's fetchText callback), write ONLY the target
 *               named vector (updateVectors preserves payload + the old vector).
 *               Resumable: scroll offset is paged; already-filled points re-embed
 *               harmlessly on a restart.
 *   4. FLIP   — the caller swaps the active pin to the target (a config/DB write,
 *               instant + atomic + reversible). Reads (`using`) + server-managed embed
 *               now use the target. Keep dual-write briefly until the drop.
 *   5. DROP   — deleteVectorName: remove the old named vector (reclaims storage).
 *               The point of no return — gate behind admin confirm + a
 *               "backfill 100% + N minutes dual-write observed" check.
 *
 * CRITICAL API NOTE (verified against @qdrant/js-client-rest v1.18):
 *   createVectorName(collection, vectorName, config, opts?) — vectorName + config
 *   are POSITIONAL (config = { dense: { size, distance } }), NOT a single body
 *   object. deleteVectorName(collection, vectorName, opts?) — vectorName is
 *   positional. The brief's `update_collection`-adds-a-vector claim is WRONG;
 *   updateCollection only tweaks hnsw/quantization of EXISTING vectors.
 *
 * This module is Prisma-free: it takes the active pin as args and the source
 * text via a callback, so the api/worker own the DB + the pin persistence.
 */
import type { QdrantClient } from '@qdrant/js-client-rest'
import type { ActivePin } from '../types/index.ts'
import { vectorName } from '../embeddings/naming.ts'
import { COLLECTION } from '../qdrant/types.ts'
import { hasNamedVector } from '../qdrant/collection.ts'

export interface SwitchPlan {
  from: ActivePin
  to: ActivePin
}

/** Build a plan from (fromModel, fromDim) → (toModel, toDim). */
export function planSwitch(
  fromModel: string,
  fromDim: number,
  toModel: string,
  toDim: number,
): SwitchPlan {
  return {
    from: { modelId: fromModel, dim: fromDim, vectorName: vectorName(fromModel, fromDim) },
    to: { modelId: toModel, dim: toDim, vectorName: vectorName(toModel, toDim) },
  }
}

/**
 * STEP 1 — add the TARGET named vector slot. Idempotent: if it already exists,
 * this is a no-op (resume-safe).
 */
export async function step1AddVector(
  client: QdrantClient,
  plan: SwitchPlan,
): Promise<{ added: boolean }> {
  if (await hasNamedVector(client, plan.to.vectorName)) {
    return { added: false }
  }
  await client.createVectorName(COLLECTION, plan.to.vectorName, {
    dense: { size: plan.to.dim, distance: 'Cosine' },
  })
  return { added: true }
}

/**
 * DUAL-WRITE primitive (step 2). Write freshly TARGET-embedded vectors onto
 * existing points' TARGET named vector (additive — leaves the active vector
 * intact). Used both for the live dual-write path and the backfill below.
 */
export async function writeTargetVectors(
  client: QdrantClient,
  plan: SwitchPlan,
  points: Array<{ id: string | number; vector: number[] }>,
): Promise<void> {
  if (points.length === 0) return
  await client.updateVectors(COLLECTION, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: { [plan.to.vectorName]: p.vector },
    })),
  })
}

export interface ReembedDeps {
  /** Re-embed with the TARGET model (caller wires a target-pinned embedder). */
  embed: (texts: string[]) => Promise<number[][]>
  /** Postgres lookup: row_id → source text. Caller owns the DB. */
  fetchText: (rowIds: string[]) => Promise<Map<string, string>>
  /** Optional progress sink. */
  onProgress?: (migrated: number) => void
  /** Scroll page size (default 256). */
  pageSize?: number
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const candidate = err as { status?: unknown; response?: { status?: unknown }; message?: unknown }
  return candidate.status === 404 || candidate.response?.status === 404 || candidate.message === 'Not Found'
}

/**
 * A vector point may disappear between scroll and update when a memory/document
 * is deleted during a live migration.  Retrying the batch point-by-point keeps
 * the remaining live rows moving without treating that expected race as a failed
 * model switch.
 */
async function writeTargetVectorsIgnoringDeleted(
  client: QdrantClient,
  plan: SwitchPlan,
  points: Array<{ id: string | number; vector: number[] }>,
): Promise<number> {
  if (points.length === 0) return 0
  try {
    await writeTargetVectors(client, plan, points)
    return points.length
  } catch (err) {
    if (!isNotFound(err)) throw err
  }

  let written = 0
  for (const point of points) {
    try {
      await writeTargetVectors(client, plan, [point])
      written++
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }
  return written
}

/**
 * STEP 3 — backfill: scroll every point, re-embed from Postgres source text,
 * write the target named vector. with_vector:false (we re-embed from text, not
 * from the old vector). Loops until next_page_offset is null.
 */
export async function step3Reembed(
  client: QdrantClient,
  plan: SwitchPlan,
  deps: ReembedDeps,
): Promise<{ migrated: number }> {
  const pageSize = deps.pageSize ?? 256
  let offset: string | number | undefined = undefined
  let migrated = 0

  for (;;) {
    const page = await client.scroll(COLLECTION, {
      limit: pageSize,
      offset,
      with_payload: true,
      with_vector: false,
    })
    if (page.points.length === 0) break

    const rowIds = page.points.map((pt) => String((pt.payload as Record<string, unknown>).row_id))
    const textByRow = await deps.fetchText(rowIds)
    // Qdrant can hold a briefly stale point after an API deletion.  Source text
    // is authoritative: do not create an empty embedding for a row that no
    // longer exists in Postgres.
    const livePoints = page.points.filter((pt) => textByRow.has(String((pt.payload as Record<string, unknown>).row_id)))
    const texts = livePoints.map((pt) => textByRow.get(String((pt.payload as Record<string, unknown>).row_id))!)
    const vecs = await deps.embed(texts) // TARGET model

    migrated += await writeTargetVectorsIgnoringDeleted(
      client,
      plan,
      livePoints.map((pt, i) => ({ id: pt.id, vector: vecs[i] ?? [] })),
    )

    deps.onProgress?.(migrated)

    const next = page.next_page_offset
    if (next === null || next === undefined) break
    offset = next as string | number
  }

  return { migrated }
}

/**
 * STEP 5 — drop the OLD named vector. Idempotent: a 404 (already dropped) is
 * treated as done. The point of no return.
 */
export async function step5DropOld(
  client: QdrantClient,
  plan: SwitchPlan,
): Promise<{ dropped: boolean }> {
  if (!(await hasNamedVector(client, plan.from.vectorName))) {
    return { dropped: false }
  }
  await client.deleteVectorName(COLLECTION, plan.from.vectorName)
  return { dropped: true }
}

/**
 * STEP 4 (flip) is the CALLER's config/DB write — there is no Qdrant call. We
 * expose a typed marker so callers' code reads clearly: the new active pin to
 * persist is simply `plan.to`. Returns it for ergonomics.
 */
export function step4FlipTarget(plan: SwitchPlan): ActivePin {
  return plan.to
}
