-- P1 (full-local UX/UI redesign).
--
-- app_user: optional local-dashboard password (a UI SOFT LOCK only — the local
-- API/MCP stay no-auth) + a backend avatar object key (MinIO pm-evidence bucket).
-- Both nullable; app_user is a CONTROL table (outside RLS, no pm_app grant), so the
-- new columns inherit that — no rls.sql change.
ALTER TABLE "app_user" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "app_user" ADD COLUMN "avatar_object_key" TEXT;

-- notify_settings: Slack BOT delivery (token + channel ids) alongside the incoming
-- webhook, and default notifications OFF (no point enabling before configuration;
-- they were inert without recipients anyway). notify_settings is a CONTROL table
-- (rls.sql already REVOKEs pm_app on it) → the new columns inherit that; no rls.sql
-- change. The slack_bot_token is a SECRET and is never returned by the GET endpoint.
ALTER TABLE "notify_settings" ADD COLUMN "slack_bot_token" TEXT;
ALTER TABLE "notify_settings" ADD COLUMN "slack_channel_ids" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "notify_settings" ALTER COLUMN "enabled" SET DEFAULT false;
