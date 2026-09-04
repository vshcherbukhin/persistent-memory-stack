-- Phase 8: PII/DLP layer (#10) — SecurityAlert (data plane, RLS) + NotifySettings (control plane, NO RLS).
--
-- security_alert: a PII/secret finding raised by the DLP layer (the api write-gate's
-- deeper scans and the worker — document-ingest block + the `pii-scan` scheduled job).
-- It IS team-partitioned and DOES get row-level security, BUT — unlike the 9 shared
-- evidence tables — its read is NOT universal: a finding reveals that a specific team
-- holds sensitive data, so rls.sql §5b restricts read to own-team OR global super-admin.
-- Findings are stored REDACTED (type + offset + masked excerpt), never the raw value.
--
-- notify_settings: per-team notification routing for security alerts. One row per team
-- (team-admins edit their own) PLUS a GLOBAL row with team_id NULL (super-admin edits
-- it; the support team is alerted on findings across ALL teams). Like
-- system_settings / model_usage_rollup / scheduled_job it is a CONTROL table — NOT
-- team-partitioned and gets NO row-level security; read/written ONLY by the owner
-- (ownerPrisma), admin-gated at the API. Its pm_app grant is REVOKEd in rls.sql (NOT
-- here) — on a FRESH install pm_app does not exist yet at migrate-deploy time.

-- CreateTable
CREATE TABLE "security_alert" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "source_kind" TEXT NOT NULL,
    "row_id" UUID,
    "detector" TEXT NOT NULL,
    "finding_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'high',
    "redacted_excerpt" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notify_settings" (
    "id" UUID NOT NULL,
    "team_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slack_webhook_url" TEXT,
    "min_severity" TEXT NOT NULL DEFAULT 'high',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notify_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_alert_team_id_project_idx" ON "security_alert"("team_id", "project");
CREATE INDEX "security_alert_team_id_severity_idx" ON "security_alert"("team_id", "severity");
CREATE INDEX "security_alert_team_id_resolved_idx" ON "security_alert"("team_id", "resolved");
CREATE INDEX "security_alert_row_id_idx" ON "security_alert"("row_id");

-- CreateIndex
-- One row per team. Postgres treats NULLs as distinct, so this does NOT bound the
-- single global (team_id IS NULL) row — that is enforced by the admin API upsert.
CREATE UNIQUE INDEX "notify_settings_team_id_key" ON "notify_settings"("team_id");

-- AddForeignKey
ALTER TABLE "security_alert" ADD CONSTRAINT "security_alert_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notify_settings" ADD CONSTRAINT "notify_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
