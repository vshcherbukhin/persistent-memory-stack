-- Phase 10 (#5): embedding-model switch status on the SystemSettings singleton
-- (control table, owner-only). Null = idle. While a re-embed migration runs the
-- api stamps {state,from,to,migrated,startedAt,...} here so the dashboard shows
-- progress and a concurrent switch is refused. JSONB (no RLS — SystemSettings is
-- owner-only via ownerPrisma).

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN "embedding_switch" JSONB;
