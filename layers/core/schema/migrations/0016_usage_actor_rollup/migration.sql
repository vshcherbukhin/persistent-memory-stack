-- Track usage by actor while preserving existing aggregate rows as background
-- system usage. actor_id is a real app_user id when request-scoped; otherwise
-- "system" for worker/internal/background usage.

ALTER TABLE "model_usage_rollup"
  ADD COLUMN "actor_id" TEXT NOT NULL DEFAULT 'system';

DROP INDEX "model_usage_rollup_hour_utc_service_model_key";

CREATE UNIQUE INDEX "model_usage_rollup_hour_utc_service_model_actor_id_key"
  ON "model_usage_rollup"("hour_utc", "service", "model", "actor_id");

CREATE INDEX "model_usage_rollup_actor_id_idx"
  ON "model_usage_rollup"("actor_id");
