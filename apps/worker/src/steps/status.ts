/**
 * Step helper — IngestJob status transitions.
 *
 * queued → extracting → embedding → completed | failed. Each call runs in its own
 * runInTenant tx (pm_app, RLS-scoped to the job's team via the ALS ctx). attempts
 * mirrors job.attemptsMade so the GET /ingest/:jobId surface shows retry progress.
 */
import { runInTenant, type IngestStatus, type GraphStatus } from '@pm/db'

export function setStatus(
  ingestJobId: string,
  status: IngestStatus,
  attempts: number,
  error?: string,
): Promise<unknown> {
  return runInTenant((tx) =>
    tx.ingestJob.update({
      where: { id: ingestJobId },
      data: { status, attempts, error: error ?? null },
    }),
  )
}

/**
 * Persist the Graphiti add_episode outcome SEPARATELY from `status`. Step 6 is
 * best-effort, so `status` reaches `completed` even when the episode write fails;
 * `graph_status` is what makes the "in Qdrant but not the graph" partial state
 * queryable (issue #9). Own runInTenant tx, RLS-scoped to the job's team.
 */
export function setGraphStatus(
  ingestJobId: string,
  graphStatus: GraphStatus,
): Promise<unknown> {
  return runInTenant((tx) =>
    tx.ingestJob.update({
      where: { id: ingestJobId },
      data: { graphStatus },
    }),
  )
}
