-- Phase 5: managed scheduled-worker subsystem — the ScheduledJob registry (control plane; NO RLS).
--
-- One row per code-registered background job (e.g. "usage-sweep"). The row is the
-- durable source of truth for the schedule (cron) + enabled flag; BullMQ
-- job-schedulers in Redis drive the ticks and are reconciled to these rows on
-- worker boot + every dashboard mutation. Like system_settings / model_usage_rollup
-- it is NOT team-partitioned and gets NO row-level security — read/written ONLY by
-- the owner (ownerPrisma); admin-gated at the API.
--
-- IMPORTANT (the pm_app grant): this table is created by the owner. On an UPDATE,
-- rls.sql's `ALTER DEFAULT PRIVILEGES ... GRANT ... TO pm_app` has already run, so a
-- newly-created owner table inherits the pm_app DML grant. rls.sql REVOKEs that grant
-- (guarded) so this stays owner-only. The REVOKE lives in rls.sql — NOT here —
-- because on a FRESH install the pm_app role does not exist yet at migrate-deploy
-- time (rls.sql creates it afterwards). layers/core/schema/rls.sql is the single place
-- RLS/grants are managed.

-- CreateTable
CREATE TABLE "scheduled_job" (
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "last_run_at" TIMESTAMP(3),
    "last_finish_at" TIMESTAMP(3),
    "last_duration_ms" INTEGER,
    "last_error" TEXT,
    "log_tail" TEXT,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_job_pkey" PRIMARY KEY ("name")
);
