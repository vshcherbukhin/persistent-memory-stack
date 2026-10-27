BEGIN;
-- Additive compatibility window. Original IDs, content, timestamps, project labels,
-- provenance, legacy partitions and migration history are retained verbatim.
ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS knowledge JSONB,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS memory_type TEXT NOT NULL DEFAULT 'legacy_unclassified',
  ADD COLUMN IF NOT EXISTS assertion_status TEXT NOT NULL DEFAULT 'legacy_unclassified',
  ADD COLUMN IF NOT EXISTS topic_tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS project_associations TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS system_associations TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ownership_state TEXT NOT NULL DEFAULT 'unresolved',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP(3);

-- Positively identify only records authored by the validated local owner in their
-- existing partition. NULL/foreign authors, other partitions and remote-cache
-- evidence remain preserved but outside active personal recall. No ownership is
-- inferred from project names, folder names, grants or mere database presence.
UPDATE memory m SET ownership_state = 'personal',
  project_associations = CASE WHEN m.project = 'general' THEN '{}'::TEXT[] ELSE ARRAY[m.project] END
FROM local_identity li
WHERE m.ownership_state = 'unresolved' AND li.id = 'singleton' AND m.team_id = li.team_id AND m.created_by_id = li.user_id
  AND NOT (COALESCE(m.metadata, '{}'::JSONB) ?| ARRAY['sharedSource','remoteTeamId','shared_connection','remote_source']);

CREATE TABLE IF NOT EXISTS memory_revision (
  id UUID PRIMARY KEY, team_id UUID NOT NULL, memory_id UUID NOT NULL,
  revision INTEGER NOT NULL, snapshot JSONB NOT NULL, intent TEXT NOT NULL,
  reason TEXT NOT NULL, evidence JSONB NOT NULL, actor_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(memory_id, revision)
);
CREATE INDEX IF NOT EXISTS memory_revision_team_id_memory_id_idx ON memory_revision(team_id, memory_id);
CREATE TABLE IF NOT EXISTS memory_write_receipt (
  team_id UUID NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response JSONB NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(team_id, key)
);
CREATE TABLE IF NOT EXISTS knowledge_term (
  team_id UUID NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}', reason TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(team_id, kind, name)
);
INSERT INTO knowledge_term(team_id, kind, name, reason)
SELECT DISTINCT team_id, 'project', project, 'Preserved historical personal project label; no new assertion or evidence inferred.'
FROM memory WHERE ownership_state = 'personal' AND project <> 'general'
ON CONFLICT (team_id, kind, name) DO NOTHING;
CREATE INDEX IF NOT EXISTS memory_team_id_ownership_state_deleted_at_idx ON memory(team_id, ownership_state, deleted_at);
CREATE INDEX IF NOT EXISTS memory_project_associations_idx ON memory USING GIN(project_associations);
CREATE INDEX IF NOT EXISTS memory_topic_tags_idx ON memory USING GIN(topic_tags);
CREATE INDEX IF NOT EXISTS memory_personal_lexical_idx ON memory USING GIN(to_tsvector('simple', content));

-- Extend the existing source/claim/entity/relationship pipeline, rather than
-- creating a competing knowledge engine. Nullable keys leave history intact.
ALTER TABLE source ADD COLUMN IF NOT EXISTS source_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS source_team_id_source_fingerprint_key ON source(team_id, source_fingerprint);
ALTER TABLE entity ADD COLUMN IF NOT EXISTS resolution_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS entity_team_id_resolution_key_key ON entity(team_id, resolution_key);
ALTER TABLE claim ADD COLUMN IF NOT EXISTS memory_id UUID, ADD COLUMN IF NOT EXISTS memory_revision INTEGER,
  ADD COLUMN IF NOT EXISTS source_ids UUID[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS claim_memory_id_memory_revision_key ON claim(memory_id, memory_revision);
ALTER TABLE relationship ADD COLUMN IF NOT EXISTS memory_id UUID, ADD COLUMN IF NOT EXISTS memory_revision INTEGER;
CREATE INDEX IF NOT EXISTS relationship_memory_id_memory_revision_idx ON relationship(memory_id, memory_revision);

COMMIT;
