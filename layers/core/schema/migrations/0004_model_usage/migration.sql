-- Phase: model-usage metrics — hourly rollups (control plane; NO RLS).
--
-- Per-(hour, service, model) token + request counters for the dashboard Usage
-- page. Like system_settings it is NOT team-partitioned and gets NO row-level
-- security — read/written ONLY by the owner (ownerPrisma); admin-gated at the API.
--
-- IMPORTANT (the pm_app grant): this table is created by the owner. On an UPDATE,
-- rls.sql's `ALTER DEFAULT PRIVILEGES ... GRANT ... TO pm_app` has already run, so
-- a newly-created owner table inherits the pm_app DML grant. rls.sql REVOKEs that
-- grant (guarded) so this stays owner-only. The REVOKE lives in rls.sql — NOT
-- here — because on a FRESH install the pm_app role does not exist yet at
-- migrate-deploy time (rls.sql creates it afterwards). layers/core/schema/rls.sql is otherwise
-- the single place RLS/grants are managed.

-- CreateTable
CREATE TABLE "model_usage_rollup" (
    "id" BIGSERIAL NOT NULL,
    "hour_utc" TIMESTAMP(3) NOT NULL,
    "service" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens_in" BIGINT NOT NULL DEFAULT 0,
    "tokens_out" BIGINT NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "model_usage_rollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_usage_rollup_hour_utc_service_model_key" ON "model_usage_rollup"("hour_utc", "service", "model");

-- CreateIndex
CREATE INDEX "model_usage_rollup_hour_utc_idx" ON "model_usage_rollup"("hour_utc");

-- CreateIndex
CREATE INDEX "model_usage_rollup_service_model_idx" ON "model_usage_rollup"("service", "model");
