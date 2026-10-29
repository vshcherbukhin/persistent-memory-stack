-- Synthetic rows for an isolated pre-upgrade copy only. The harness must verify
-- the task-owned container/database marker before applying this fixture.
INSERT INTO team(id,name,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000000010','synthetic-foreign-partition',NOW(),NOW());
INSERT INTO app_user(id,team_id,admin_level,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000010','none',NOW(),NOW());
INSERT INTO memory(id,team_id,created_by_id,project,content,category,shape,entities,metadata,created_at,updated_at)
SELECT '00000000-0000-4000-8000-000000000001',li.team_id,li.user_id,'synthetic-owner-filter',
  'Synthetic positively owned legacy knowledge remains personally recallable.', 'data-constraint','atomic',ARRAY['fixture_positive_owner'],'{}'::JSONB,NOW(),NOW()
FROM local_identity li WHERE li.id='singleton';
INSERT INTO memory(id,team_id,created_by_id,project,content,category,shape,entities,metadata,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000011','synthetic-owner-filter',
  'Synthetic foreign ownership cannot be changed by copying a project name.', 'data-constraint','atomic',ARRAY['fixture_foreign_owner'],'{}'::JSONB,NOW(),NOW());
INSERT INTO memory(id,team_id,created_by_id,project,content,category,shape,entities,metadata,created_at,updated_at)
SELECT '00000000-0000-4000-8000-000000000003',li.team_id,NULL,'synthetic-owner-filter',
  'Synthetic unresolved authorship remains preserved outside active personal recall.', 'data-constraint','atomic',ARRAY['fixture_unknown_owner'],'{}'::JSONB,NOW(),NOW()
FROM local_identity li WHERE li.id='singleton';
INSERT INTO memory(id,team_id,created_by_id,project,content,category,shape,entities,metadata,created_at,updated_at)
SELECT '00000000-0000-4000-8000-000000000004',li.team_id,li.user_id,'synthetic-owner-filter',
  'Synthetic cached remote evidence remains outside active personal recall.', 'data-constraint','atomic',ARRAY['fixture_cached_source'],'{"sharedSource":"synthetic-remote"}'::JSONB,NOW(),NOW()
FROM local_identity li WHERE li.id='singleton';
