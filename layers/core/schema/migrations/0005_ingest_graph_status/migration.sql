-- Phase: IngestJob graph-status tracking (issue #9).
--
-- The worker pipeline's step 6 (Graphiti add_episode) is BEST-EFFORT: a failure
-- there logs and the job is still marked `status = 'completed'`, with no way to
-- tell "in Qdrant but not in the graph" apart from a fully-graphed job. This adds
-- a SEPARATE `graph_status` column so that partial state is queryable. The
-- existing `status` semantics are unchanged (the job still completes best-effort).
--
-- ingest_job is a DATA-plane, team-partitioned table that already carries RLS
-- (ENABLE + FORCE) from 0001_init via layers/core/schema/rls.sql — adding a column does NOT
-- change its policies, so rls.sql is intentionally untouched by this migration.
--
-- Re-running graph-missing docs (graph_status = 'failed') is wired in P5 (the
-- scheduled-worker subsystem); no scheduler is introduced here.

-- CreateEnum
CREATE TYPE "GraphStatus" AS ENUM ('pending', 'ok', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "ingest_job" ADD COLUMN "graph_status" "GraphStatus" NOT NULL DEFAULT 'pending';
