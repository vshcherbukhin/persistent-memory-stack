-- Retire automatic archive behavior without deleting user memories. Existing
-- archived_at values were produced only by the retired worker, so make those
-- records eligible for normal retrieval again. Retain the columns for one
-- compatibility release; a future approved migration may remove them.
UPDATE "memory"
SET "archived_at" = NULL
WHERE "archived_at" IS NOT NULL;
