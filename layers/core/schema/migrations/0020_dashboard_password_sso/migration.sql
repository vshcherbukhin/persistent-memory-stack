-- Human dashboard auth: password-first login, future SSO mode, and temporary-password tracking.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DashboardLoginMode') THEN
    CREATE TYPE "DashboardLoginMode" AS ENUM ('password', 'sso');
  END IF;
END $$;

ALTER TABLE "app_user"
  ADD COLUMN IF NOT EXISTS "password_temporary" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);

ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "dashboard_login_mode" "DashboardLoginMode" NOT NULL DEFAULT 'password';
