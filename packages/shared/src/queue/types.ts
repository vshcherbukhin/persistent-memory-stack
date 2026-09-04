/**
 * @pm/shared/queue — the BullMQ ingest contract (Prisma-free).
 *
 * The job payload is built by the api at POST /ingest from the request's
 * server-derived identity (getCtx().teamId) AFTER the Source/Document/IngestJob
 * rows exist and the original blob is in MinIO. The worker NEVER trusts a
 * client-supplied team — teamId here is already server-stamped at enqueue time.
 * project/sessionId are agent tags carried through for stamping the canonical
 * rows. Both api (producer) and worker (consumer) import this so the payload type
 * is single-sourced.
 */
export const INGEST_QUEUE = 'pm.ingest' as const

/** One unit of ingest work. All ids are Postgres uuids the api already created. */
export interface IngestJobData {
  /** The IngestJob.id row — the worker drives its status column. The Bull jobId
   *  is set === ingestJobId for idempotency (a re-enqueue collapses). */
  ingestJobId: string
  sourceId: string
  documentId: string
  /** SERVER-DERIVED at enqueue (api identity.teamId). The RLS app.team_id. */
  teamId: string
  /** Agent tag; "general" default, never null. */
  project: string
  /** MinIO object key of the ORIGINAL uploaded blob. */
  minioObjectKey: string
  /** Best-effort content type (from the multipart part). */
  mimeType: string
  filename: string
  sessionId: string | null
}

/** Job return value (BullMQ stores it; useful for tests + the /ingest GET). */
export interface IngestJobResult {
  chunks: number
  /** 0 in client-managed embeddings (chunks left pending). */
  embedded: number
  graphitiEpisodeUuid?: string
  mode: 'server' | 'client-bridge'
}
