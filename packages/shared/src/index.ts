/**
 * @pm/shared — persistent-memory reusable core.
 *
 * Embedding adapter (ollama/voyage/openai) + Qdrant multi-tenant vector layer
 * (named vectors + is_tenant) + the dimension/provider switch tool. Prisma-FREE
 * by design: deals in plain number[][] vectors + Qdrant payloads; the api/worker
 * own Postgres and pass row ids / team ids in.
 *
 * Phase 6 adds the ingest infra (all Prisma-free): storage (MinIO blob layer),
 * queue (the BullMQ ingest contract), extract (PDF/docx/txt/md text + chunker).
 *
 * Subpath exports also exist (`@pm/shared/embeddings`, `/qdrant`, `/switch`,
 * `/storage`, `/queue`, `/extract`, `/types`) for narrower surfaces.
 */
export * from './types/index.ts'
export * from './embeddings/index.ts'
export * from './qdrant/index.ts'
export * from './switch/index.ts'
export * from './storage/index.ts'
export * from './queue/index.ts'
export * from './extract/index.ts'
