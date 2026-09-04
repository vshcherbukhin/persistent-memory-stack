-- Retain every episode provenance and make dashboard cascade previews durable,
-- short-lived, and single-use. Existing v2 rows are backfilled from their current
-- episode pointer; pre-v2 legacy rows intentionally remain unmigrated until the
-- installer rebuilds them from authoritative Postgres data.

CREATE TABLE "graph_episode_provenance" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL,
    "subject_kind" "GraphSubjectKind" NOT NULL,
    "subject_id" UUID NOT NULL,
    "graph_group_id" TEXT NOT NULL,
    "graph_episode_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "graph_episode_provenance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "graph_episode_provenance_graph_group_id_graph_episode_id_key"
  ON "graph_episode_provenance"("graph_group_id", "graph_episode_id");
CREATE INDEX "graph_episode_provenance_subject_kind_subject_id_idx"
  ON "graph_episode_provenance"("subject_kind", "subject_id");
CREATE INDEX "graph_episode_provenance_team_id_project_idx"
  ON "graph_episode_provenance"("team_id", "project");
ALTER TABLE "graph_episode_provenance"
  ADD CONSTRAINT "graph_episode_provenance_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "graph_delete_preview" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "team_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "subject_kind" "GraphSubjectKind" NOT NULL,
    "subject_id" UUID NOT NULL,
    "subject_updated_at" TIMESTAMP(3) NOT NULL,
    "episodes" JSONB NOT NULL,
    "impact" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "graph_delete_preview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "graph_delete_preview_token_key" ON "graph_delete_preview"("token");
CREATE INDEX "graph_delete_preview_subject_kind_subject_id_idx"
  ON "graph_delete_preview"("subject_kind", "subject_id");
CREATE INDEX "graph_delete_preview_team_id_expires_at_idx"
  ON "graph_delete_preview"("team_id", "expires_at");
ALTER TABLE "graph_delete_preview"
  ADD CONSTRAINT "graph_delete_preview_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "graph_episode_provenance" (
  "id", "team_id", "project", "subject_kind", "subject_id", "graph_group_id", "graph_episode_id"
)
SELECT gen_random_uuid(), "team_id", "project", 'memory'::"GraphSubjectKind", "id", "graph_group_id", "graph_episode_id"
FROM "memory"
WHERE "graph_group_id" IS NOT NULL AND "graph_episode_id" IS NOT NULL
ON CONFLICT ("graph_group_id", "graph_episode_id") DO NOTHING;

INSERT INTO "graph_episode_provenance" (
  "id", "team_id", "project", "subject_kind", "subject_id", "graph_group_id", "graph_episode_id"
)
SELECT gen_random_uuid(), "team_id", "project", 'document'::"GraphSubjectKind", "id", "graph_group_id", "graph_episode_id"
FROM "document"
WHERE "graph_group_id" IS NOT NULL AND "graph_episode_id" IS NOT NULL
ON CONFLICT ("graph_group_id", "graph_episode_id") DO NOTHING;
