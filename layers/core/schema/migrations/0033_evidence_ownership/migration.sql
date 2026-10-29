BEGIN;
-- Historical source/document authorship was not recorded by the old upload
-- path. Preserve it unresolved rather than treating partition presence as proof.
ALTER TABLE source ADD COLUMN IF NOT EXISTS owner_id UUID,
  ADD COLUMN IF NOT EXISTS ownership_state TEXT NOT NULL DEFAULT 'unresolved';
ALTER TABLE investigation ADD COLUMN IF NOT EXISTS owner_id UUID,
  ADD COLUMN IF NOT EXISTS ownership_state TEXT NOT NULL DEFAULT 'unresolved';
ALTER TABLE graph_lifecycle_operation ADD COLUMN IF NOT EXISTS ownership_validated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS relationship_dependencies JSONB;
-- Server-captured historical witnesses bound legacy conversion to records that
-- really existed with positively established ownership before the new contract.
INSERT INTO memory_revision(id,team_id,memory_id,revision,snapshot,intent,reason,evidence,actor_id)
SELECT gen_random_uuid(),m.team_id,m.id,m.revision,
  to_jsonb(m) || jsonb_build_object('revision',m.revision,'createdById',m.created_by_id,
    'createdAt',m.created_at AT TIME ZONE 'UTC','recordUpdatedAt',m.record_updated_at AT TIME ZONE 'UTC'),
  'legacy_snapshot','Original personally owned legacy state captured during the additive migration; no assertion certainty inferred.','[]'::JSONB,NULL
FROM memory m WHERE m.ownership_state='personal' AND m.knowledge IS NULL
ON CONFLICT(memory_id,revision) DO NOTHING;
COMMIT;
