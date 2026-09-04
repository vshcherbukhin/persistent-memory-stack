-- Manual memory verification was an unused trust override. Retrieval now always
-- derives trust from source provenance × write-time confidence.
DROP INDEX IF EXISTS "memory_team_id_verified_idx";
ALTER TABLE "memory"
  DROP COLUMN IF EXISTS "verified",
  DROP COLUMN IF EXISTS "verified_at",
  DROP COLUMN IF EXISTS "verified_by_id";
