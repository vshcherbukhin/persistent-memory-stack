/**
 * persistent-memory-worker — the dependency bundle passed to the pipeline
 * processor. Built once at boot in index.ts; the steps take ids + this bundle.
 */
import type {
  Embedder,
  QdrantClient,
  ActivePin,
  MinioClient,
  EmbeddingMode,
  Queue,
  IngestJobData,
} from '@pm/shared'
import type { DlpClient } from '@pm/security-dlp'

export interface WorkerDeps {
  qdrant: QdrantClient
  /** Mode A → a server embedder; Mode B → null (chunks stay pending). */
  embedder: Embedder | null
  pin: ActivePin
  minio: MinioClient
  embeddingMode: EmbeddingMode
  /** The ingest producer queue — the ingest-reconciler re-enqueues lost jobs onto it. */
  ingestQueue: Queue<IngestJobData>
  // DLP/PII (Phase 8): the sidecar client + the resolved gate policy. Used by the
  // ingest pipeline (block sensitive documents) + the pii-scan scheduled job.
  dlpClient: DlpClient
  piiEntities: readonly string[]
  piiScoreThreshold: number
  /** Block sensitive DOCUMENT ingests (PII_INGEST_GATE_ENABLED). */
  piiIngestGateEnabled: boolean
  graphitiUrl: string
  graphitiTimeoutMs: number
  chunkMaxTokens: number
  chunkOverlapTokens: number
  /** Worker read ceiling (Phase 12, #8) — bounds the per-job buffer to avoid OOM. */
  maxFileBytes: number
}
