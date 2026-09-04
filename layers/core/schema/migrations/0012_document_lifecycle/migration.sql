-- Phase 11 (#6): document lifecycle — dedup / version-in-place / derived-memory
-- propagation. New columns on `document`:
--   filename      — raw upload filename, the stable logical-doc identity within
--                   (team, project) that re-uploads dedup against (distinct from
--                   the user-overridable `title`).
--   content_hash  — sha256 of normalized extracted text (set by the worker). A
--                   re-ingest with an unchanged hash is skipped; a changed hash
--                   bumps version_number IN PLACE + re-chunks/re-embeds.
--   version_number — incremented on each content change (audit; no version chain).
-- The (team_id, project, filename) index serves the re-upload dedup lookup.

-- AlterTable
ALTER TABLE "document" ADD COLUMN "filename" TEXT;
ALTER TABLE "document" ADD COLUMN "content_hash" TEXT;
ALTER TABLE "document" ADD COLUMN "version_number" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "document_team_id_project_filename_idx" ON "document"("team_id", "project", "filename");
