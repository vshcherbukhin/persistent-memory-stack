-- Phase 11 review fix: promote the (team_id, project, filename) dedup index to a
-- UNIQUE constraint so a concurrent first-upload of the same filename cannot create
-- two logical documents — the DB rejects the second insert (the api maps the P2002
-- to a 409 retry). Nullable filename rows (pre-P11) are exempt: Postgres treats NULLs
-- as distinct, so existing null-filename documents do not collide.

-- DropIndex (the plain lookup index added in 0012)
DROP INDEX IF EXISTS "document_team_id_project_filename_idx";

-- CreateIndex (unique — Prisma's @@unique naming convention uses the _key suffix)
CREATE UNIQUE INDEX "document_team_id_project_filename_key" ON "document"("team_id", "project", "filename");
