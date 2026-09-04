-- Phase 9 — SystemSettings singleton (control plane; NO RLS).
--
-- A single runtime-tunable config row: embedding topology (Mode A "server" /
-- Mode B "client_bridge") + the team-wide pinned embedding model/dim. Lives
-- alongside team / app_user / team_grant: it is NOT team-partitioned and gets
-- NO row-level security — it is fail-closed at the API by requireSuperuser.
-- Therefore layers/core/schema/rls.sql is intentionally untouched by this migration.
--
-- Exactly-one-row is enforced by a fixed default PK ('singleton') PLUS a CHECK
-- constraint (id = 'singleton') that Prisma cannot express in the schema, so it
-- is added here by hand. Upserts target where { id: 'singleton' }.

-- CreateEnum
CREATE TYPE "EmbeddingMode" AS ENUM ('server', 'client_bridge');

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "embedding_mode" "EmbeddingMode" NOT NULL DEFAULT 'server',
    "active_embed_model" TEXT NOT NULL,
    "active_embed_dim" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- Singleton guard: only the row id='singleton' may ever exist. Not expressible
-- in the Prisma schema, so it is enforced at the DB layer here.
ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_singleton" CHECK ("id" = 'singleton');
