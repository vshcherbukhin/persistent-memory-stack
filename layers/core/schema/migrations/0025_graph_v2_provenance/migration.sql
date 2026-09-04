-- Graph v2 provenance and durable lifecycle state.
--
-- This migration is additive: live writers continue using their existing graph
-- path until the Graph v2 worker lifecycle is enabled. Existing rows retain NULL
-- provenance and are rebuilt from authoritative Postgres data by the updater.

CREATE TYPE "MemorySurface" AS ENUM ('personal', 'shared');
CREATE TYPE "GraphSubjectKind" AS ENUM ('memory', 'document');
CREATE TYPE "GraphLifecycleOperationKind" AS ENUM ('remove', 'replace');
CREATE TYPE "GraphLifecycleStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE "GraphMigrationState" AS ENUM ('snapshot_confirmed', 'v2_rebuild_running', 'v2_rebuild_validating', 'legacy_cleanup_running', 'complete', 'failed');

ALTER TABLE "document" ADD COLUMN "graph_group_id" TEXT;
ALTER TABLE "document" ADD COLUMN "graph_episode_id" TEXT;
ALTER TABLE "memory" ADD COLUMN "graph_group_id" TEXT;
ALTER TABLE "memory" ADD COLUMN "graph_episode_id" TEXT;

CREATE INDEX "document_graph_group_id_idx" ON "document"("graph_group_id");
CREATE INDEX "memory_graph_group_id_idx" ON "memory"("graph_group_id");

CREATE TABLE "project_memory_binding" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project" TEXT NOT NULL,
    "surface" "MemorySurface" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_memory_binding_general_personal_check" CHECK ("project" <> 'general' OR "surface" = 'personal'),
    CONSTRAINT "project_memory_binding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "project_memory_binding_user_id_project_key" ON "project_memory_binding"("user_id", "project");
CREATE INDEX "project_memory_binding_team_id_project_idx" ON "project_memory_binding"("team_id", "project");
ALTER TABLE "project_memory_binding" ADD CONSTRAINT "project_memory_binding_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_memory_binding" ADD CONSTRAINT "project_memory_binding_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "graph_lifecycle_operation" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL,
    "subject_kind" "GraphSubjectKind" NOT NULL,
    "subject_id" UUID NOT NULL,
    "operation" "GraphLifecycleOperationKind" NOT NULL,
    "graph_group_id" TEXT NOT NULL,
    "graph_episode_id" TEXT NOT NULL,
    "status" "GraphLifecycleStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "graph_lifecycle_operation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "graph_lifecycle_operation_operation_graph_group_id_graph_episode_id_key" ON "graph_lifecycle_operation"("operation", "graph_group_id", "graph_episode_id");
CREATE INDEX "graph_lifecycle_operation_status_requested_at_idx" ON "graph_lifecycle_operation"("status", "requested_at");
CREATE INDEX "graph_lifecycle_operation_team_id_project_idx" ON "graph_lifecycle_operation"("team_id", "project");
CREATE INDEX "graph_lifecycle_operation_subject_kind_subject_id_idx" ON "graph_lifecycle_operation"("subject_kind", "subject_id");
ALTER TABLE "graph_lifecycle_operation" ADD CONSTRAINT "graph_lifecycle_operation_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "graph_migration_run" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "state" "GraphMigrationState" NOT NULL,
    "snapshot_id" TEXT,
    "metrics" JSONB,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "graph_migration_run_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "graph_migration_run_version_key" ON "graph_migration_run"("version");

CREATE TABLE "graph_usage_event" (
    "id" BIGSERIAL NOT NULL,
    "operation_id" TEXT NOT NULL,
    "subject_kind" "GraphSubjectKind" NOT NULL,
    "subject_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL,
    "graph_group_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "model" TEXT,
    "tokens_in" BIGINT NOT NULL DEFAULT 0,
    "tokens_out" BIGINT NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "success" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "graph_usage_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "graph_usage_event_operation_id_idx" ON "graph_usage_event"("operation_id");
CREATE INDEX "graph_usage_event_subject_kind_subject_id_idx" ON "graph_usage_event"("subject_kind", "subject_id");
CREATE INDEX "graph_usage_event_team_id_project_created_at_idx" ON "graph_usage_event"("team_id", "project", "created_at");
