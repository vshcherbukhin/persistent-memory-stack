-- Separate user-visible record edits from internal Memory.updated_at churn.
-- Existing rows inherit the best available historical approximation; future
-- vector, graph, access, PII, and embedding writes leave this column untouched.
ALTER TABLE "memory" ADD COLUMN "record_updated_at" TIMESTAMP(3);
UPDATE "memory" SET "record_updated_at" = "updated_at" WHERE "record_updated_at" IS NULL;
ALTER TABLE "memory" ALTER COLUMN "record_updated_at" SET NOT NULL;
ALTER TABLE "memory" ALTER COLUMN "record_updated_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "memory_team_id_project_created_at_idx"
  ON "memory"("team_id", "project", "created_at");
CREATE INDEX "memory_team_id_project_record_updated_at_idx"
  ON "memory"("team_id", "project", "record_updated_at");
CREATE INDEX "memory_team_id_project_last_accessed_at_idx"
  ON "memory"("team_id", "project", "last_accessed_at");
