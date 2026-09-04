/** @pm/shared/qdrant — public surface of the multi-tenant vector layer. */
export { COLLECTION } from './types.ts'
export type { QdrantPayload, SearchHit } from './types.ts'
export {
  makeQdrantClient,
  resolveQdrantConfig,
  QdrantClient,
} from './client.ts'
export type { QdrantConfig } from './client.ts'
export {
  ensureCollection,
  makeActivePin,
  hasNamedVector,
} from './collection.ts'
export { upsertVectors, deleteChunkPointsForDocument, pointIdForRow, QDRANT_POINT_NAMESPACE } from './upsert.ts'
export type { UpsertVectorInput, UpsertArgs } from './upsert.ts'
export { searchVectors } from './search.ts'
export type { SearchArgs } from './search.ts'
export { assertActivePin, ModelDimMismatchError } from './guard.ts'
