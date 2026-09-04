-- Dashboard-configurable fact extraction settings on the SystemSettings singleton.
-- This is owner-only control data, like the existing embedding settings. The API
-- returns masked key metadata only; raw keys never leave the API.

ALTER TABLE "system_settings"
  ADD COLUMN "fact_extraction_provider" TEXT NOT NULL DEFAULT 'anthropic',
  ADD COLUMN "fact_extraction_model" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  ADD COLUMN "fact_extraction_anthropic_api_key" TEXT,
  ADD COLUMN "fact_extraction_openai_api_key" TEXT;

ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_fact_extraction_provider"
  CHECK ("fact_extraction_provider" IN ('anthropic', 'openai'));
