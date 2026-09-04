-- Phase 9: dashboard-configurable memory retention knobs on the SystemSettings
-- singleton (control table, owner-only). The memory-archive job soft-archives
-- memories that are unverified AND below the confidence threshold AND idle longer
-- than the TTL. Defaults: 0.35 confidence floor, 30-day TTL (literature-aligned;
-- mem0 ~30d poison-window, FadeMem demote ≈0.3).

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN "memory_archive_confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.35;
ALTER TABLE "system_settings" ADD COLUMN "memory_archive_ttl_days" INTEGER NOT NULL DEFAULT 30;
