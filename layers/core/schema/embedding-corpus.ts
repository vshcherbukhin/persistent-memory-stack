/**
 * Tables whose rows prevent an installer from treating a database as empty.
 * Includes pending ingestion, graph work and provenance: no vector rows alone
 * does not prove that changing the embedding pin is safe. Identity, credentials
 * and ordinary application preferences are deliberately outside this list.
 */
export const EMBEDDING_CORPUS_TABLES = [
  'memory',
  'document',
  'chunk',
  'source',
  'claim',
  'entity',
  'relationship',
  'investigation',
  'investigation_link',
  'ingest_job',
  'graph_episode_provenance',
  'graph_lifecycle_operation',
  'graph_delete_preview',
  'project_memory_binding',
  'graph_migration_run',
] as const
