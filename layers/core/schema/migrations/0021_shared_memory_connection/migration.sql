ALTER TABLE "system_settings"
  ADD COLUMN "shared_memory_api_url" TEXT,
  ADD COLUMN "shared_memory_token" TEXT,
  ADD COLUMN "shared_memory_connected_at" TIMESTAMP(3),
  ADD COLUMN "shared_memory_checked_at" TIMESTAMP(3),
  ADD COLUMN "shared_memory_remote_config" JSONB,
  ADD COLUMN "shared_memory_remote_identity" JSONB;
