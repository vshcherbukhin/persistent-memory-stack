BEGIN;
CREATE TABLE IF NOT EXISTS memory_import_quarantine (
  id UUID PRIMARY KEY, team_id UUID NOT NULL, original_id UUID NOT NULL,
  archive_hash TEXT NOT NULL, payload JSONB NOT NULL, reason TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, original_id, archive_hash)
);

COMMIT;
