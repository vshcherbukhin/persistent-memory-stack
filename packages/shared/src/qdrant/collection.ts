/**
 * Collection management — ONE collection `memory_vectors` using NAMED VECTORS.
 *
 * ensureCollection is idempotent (safe on every boot / install.sh):
 *   1. createCollection with exactly ONE named vector = the active pin's
 *      "<slug>__<dim>" key, if the collection is absent. Adding MORE named
 *      vectors later is the switch tool's job (createVectorName), NOT a recreate.
 *   2. tenant payload index on team_id (is_tenant:true) — payload-based
 *      multitenancy, co-locates a tenant's points on disk (Qdrant v1.11+; server
 *      is v1.18.2). NOT access control on its own — the read `should` filter is.
 *   3. plain keyword index on project so project filters stay fast.
 */
import type { QdrantClient } from '@qdrant/js-client-rest'
import type { ActivePin } from '../types/index.ts'
import { vectorName } from '../embeddings/naming.ts'
import { COLLECTION } from './types.ts'

/** Build the ActivePin record from a (model, dim) pair. */
export function makeActivePin(modelId: string, dim: number): ActivePin {
  return { modelId, dim, vectorName: vectorName(modelId, dim) }
}

async function collectionExists(client: QdrantClient, name: string): Promise<boolean> {
  try {
    await client.getCollection(name)
    return true
  } catch (e) {
    const status = (e as { status?: number } | undefined)?.status
    if (status === 404) return false
    throw e
  }
}

export async function ensureCollection(
  client: QdrantClient,
  pin: ActivePin,
): Promise<void> {
  if (!(await collectionExists(client, COLLECTION))) {
    await client.createCollection(COLLECTION, {
      // MAP of named vectors. Exactly one at creation — the active pin.
      vectors: {
        [pin.vectorName]: { size: pin.dim, distance: 'Cosine' },
      },
    })
  }

  // Tenant index on team_id. Idempotent: re-create on an existing index is a
  // harmless no-op.
  await client.createPayloadIndex(COLLECTION, {
    field_name: 'team_id',
    field_schema: { type: 'keyword', is_tenant: true },
  })

  // Secondary keyword index on project (NOT a tenant — team_id is the boundary).
  await client.createPayloadIndex(COLLECTION, {
    field_name: 'project',
    field_schema: 'keyword',
  })
}

/** True iff the named vector exists in the collection schema. */
export async function hasNamedVector(
  client: QdrantClient,
  name: string,
): Promise<boolean> {
  const info = await client.getCollection(COLLECTION)
  const vectors = info.config?.params?.vectors
  if (!vectors || typeof vectors !== 'object') return false
  // A single-unnamed-vector collection has a bare config (no name keys); ours is
  // always a named-vector map, so a plain key check is correct.
  return Object.prototype.hasOwnProperty.call(vectors, name)
}

export { COLLECTION }
