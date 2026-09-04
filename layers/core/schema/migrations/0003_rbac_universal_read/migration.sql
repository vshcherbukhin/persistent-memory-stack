-- Phase 11 — RBAC rebuild to docs/internal/users_roles.md.
--
-- Two changes that evolve the access spine:
--   1. AppUser.team_id becomes NULLABLE (team-less = the independent global
--      super-admin) and its FK switches Cascade → SET NULL (deleting a team
--      nulls membership, never deletes the user). The team_role enum is dropped
--      (every team member can write their own memories; there is no read-only
--      member in the new model).
--   2. Memory gains created_by_id (author) + FK (SET NULL) + index, powering the
--      RLS ownership floor (a plain member edits/deletes only rows they created).
--
-- team_grant is KEPT — it now gates cross-team MEMORY reads through the MCP only
-- ("mounts": grantee mounts grantor → reads its memories; docs/graph are
-- universally shared). layers/core/schema/rls.sql is RE-APPLIED after this migration to
-- rewrite the policy set (universal docs, own∪mounted memory, ownership floor).

-- 1. AppUser: nullable team_id, FK Cascade → SET NULL, drop team_role.
ALTER TABLE "app_user" DROP CONSTRAINT "app_user_team_id_fkey";
ALTER TABLE "app_user" ALTER COLUMN "team_id" DROP NOT NULL;
ALTER TABLE "app_user" DROP COLUMN "team_role";
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Memory.created_by_id + FK + index.
ALTER TABLE "memory" ADD COLUMN "created_by_id" UUID;
ALTER TABLE "memory"
  ADD CONSTRAINT "memory_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "memory_created_by_id_idx" ON "memory"("created_by_id");

-- 3. Remove the now-unused TeamRole enum (team_grant is KEPT — see header).
DROP TYPE "TeamRole";
