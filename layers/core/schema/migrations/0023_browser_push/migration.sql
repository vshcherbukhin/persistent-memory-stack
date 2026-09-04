-- Browser Web Push control-plane tables.
--
-- These rows are owner-only control data:
-- - browser_push_config stores the durable VAPID keypair used to sign Web Push
--   requests. The private key must never be readable by pm_app.
-- - browser_push_subscription stores browser PushSubscription endpoint/key
--   material for local personal dashboard notifications.

CREATE TABLE "browser_push_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browser_push_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "browser_push_config_singleton_check" CHECK ("id" = 'singleton')
);

CREATE TABLE "browser_push_subscription" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "team_id" UUID,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notification_types" TEXT[] NOT NULL DEFAULT '{}',
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browser_push_subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "browser_push_subscription_endpoint_key" ON "browser_push_subscription"("endpoint");
CREATE INDEX "browser_push_subscription_team_id_idx" ON "browser_push_subscription"("team_id");
CREATE INDEX "browser_push_subscription_user_id_idx" ON "browser_push_subscription"("user_id");

ALTER TABLE "browser_push_subscription"
  ADD CONSTRAINT "browser_push_subscription_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "browser_push_subscription"
  ADD CONSTRAINT "browser_push_subscription_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
