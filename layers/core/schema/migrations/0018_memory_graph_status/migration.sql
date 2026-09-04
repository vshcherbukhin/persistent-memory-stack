-- Memory-level Graphiti sync state.
--
-- Existing rows predate the durable graph-sync marker. Mark them "ok" during the
-- migration so the new scheduled safety net does NOT silently replay every memory
-- for every team; operators can use the filtered Memory Tools rebuild for that.
-- New and edited rows default to "pending" after the migration.

ALTER TABLE "memory" ADD COLUMN "graph_status" "GraphStatus" NOT NULL DEFAULT 'ok';
ALTER TABLE "memory" ADD COLUMN "graph_synced_at" TIMESTAMP(3);
ALTER TABLE "memory" ADD COLUMN "graph_error" TEXT;

ALTER TABLE "memory" ALTER COLUMN "graph_status" SET DEFAULT 'pending';

CREATE INDEX "memory_team_id_graph_status_idx" ON "memory"("team_id", "graph_status");
