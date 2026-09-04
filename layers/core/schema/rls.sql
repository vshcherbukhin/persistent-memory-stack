-- ============================================================================
-- persistent-memory — Row-Level Security
--
-- Defense-in-depth net on the 10 DATA tables. The API choke-point is the primary
-- guard; this is the DB-level backstop that still returns only permitted rows
-- even if an API filter has a bug.
--
-- ACCESS MODEL (documentation/stack-architecture/access-model.md):
--   • READS are UNIVERSAL — any authenticated team member reads ANY team's rows.
--   • WRITES are current-team only (WITH CHECK team_id = current team) EXCEPT a
--     global super-admin (the dashboard cross-team path) who may write any team.
--   • memory adds an OWNERSHIP FLOOR — a plain member may only UPDATE/DELETE rows
--     they created; team-admins / super-admins bypass it within their team.
--
-- Apply ORDER (see install.sh / package.json): connect as the OWNER (pmuser via
-- DATABASE_MIGRATE_URL), then
--     1. `prisma migrate deploy`   (DDL — creates tables as owner pmuser)
--     2. `psql -f layers/core/schema/rls.sql`  (THIS file — role, grants, policies)
--     3. `tsx layers/core/schema/seed.ts`      (bootstrap; seed uses the owner URL → writes
--                                    control tables; data tables are FORCE'd RLS
--                                    but the seed only writes control tables).
-- Runtime (api/worker) connects as pm_app, the RLS-subject role.
--
-- WHY FORCE: pmuser OWNS the tables, and a table owner BYPASSES RLS unless the
-- table is FORCE'd. Also, ANY superuser / BYPASSRLS role bypasses RLS even with
-- FORCE — hence the dedicated NOSUPERUSER / NOBYPASSRLS `pm_app` runtime role.
-- ENABLE alone ships a silently-inert net.
--
-- WHY WIDENING IS ALWAYS A POLICY, NEVER A ROLE BYPASS: pm_app stays
-- NOSUPERUSER/NOBYPASSRLS. The global-admin cross-team write path is a PERMISSIVE
-- policy gated on the app.is_global_admin GUC — set per-request ONLY when the
-- server-derived identity is a super-admin on the dashboard plane. A handler
-- cannot grant itself this; runInTenant re-checks the identity.
--
-- Idempotent: re-runnable. Role create is guarded; every policy is dropped IF
-- EXISTS before CREATE.
-- ============================================================================

-- ── 1. Dedicated runtime role: DML-only, NOSUPERUSER, NOBYPASSRLS, owns nothing
-- The password comes from the SERVER GUC pm.app_password, set by install.sh /
-- `npm run rls` via PGOPTIONS="-c pm.app_password=$PM_APP_PASSWORD" (NOT psql -v —
-- its dotted client-var name is rejected on psql 18 and is unreadable by
-- current_setting anyway). current_setting('pm.app_password', true) reads it;
-- unset/empty COALESCEs to 'pmapp'.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pm_app') THEN
    EXECUTE format(
      'CREATE ROLE pm_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
      COALESCE(NULLIF(current_setting('pm.app_password', true), ''), 'pmapp')
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE pm_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L',
      COALESCE(NULLIF(current_setting('pm.app_password', true), ''), 'pmapp')
    );
  END IF;
END
$$;

-- ── 2. Grants: pm_app may connect + DML the data tables, NOTHING else.
-- Control tables (team / app_user / team_grant / local_identity / system_settings) are deliberately NOT granted
-- to pm_app — they are managed exclusively through the admin API as the owner.
GRANT CONNECT ON DATABASE persistent_memory TO pm_app;
GRANT USAGE ON SCHEMA public TO pm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'source','document','chunk','entity','claim','relationship',
    'investigation','investigation_link','ingest_job','memory','security_alert',
    'project_memory_binding','graph_lifecycle_operation','graph_episode_provenance','graph_delete_preview'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO pm_app', t);
  END LOOP;
END
$$;

-- Future tables created by the owner inherit the same DML grant for pm_app.
ALTER DEFAULT PRIVILEGES FOR ROLE pmuser IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pm_app;

-- model_usage_rollup is a CONTROL table (operational metrics; owner-only, like
-- system_settings). It is created AFTER the ALTER DEFAULT PRIVILEGES above, so on
-- an update it would inherit the pm_app DML grant — REVOKE it so pm_app can never
-- touch a control table. Guarded: the table may not exist yet if rls.sql ever runs
-- before the 0004 migrate-deploy (it always runs after in install/update, but be safe).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'model_usage_rollup'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.model_usage_rollup FROM pm_app';
  END IF;
END
$$;

-- model_dependency_health is a CONTROL table: it holds owner-written, safe
-- capability diagnostics and must never be readable or writable through pm_app.
-- It is created after the default pm_app grant above, so revoke that inherited
-- grant every time RLS is applied. Guarded for pre-migration installs.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'model_dependency_health'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.model_dependency_health FROM pm_app';
  END IF;
END
$$;

-- scheduled_job is a CONTROL table (the managed scheduled-worker registry;
-- owner-only, like model_usage_rollup). Same reasoning: it is created AFTER the
-- ALTER DEFAULT PRIVILEGES above, so it inherits the pm_app DML grant on an update
-- — REVOKE it so pm_app can never touch a control table. Guarded for safety.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'scheduled_job'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.scheduled_job FROM pm_app';
  END IF;
END
$$;

-- notify_settings is a CONTROL table (per-team + global notification routing for
-- security alerts; owner-only, like scheduled_job). Same reasoning: created AFTER
-- the ALTER DEFAULT PRIVILEGES, so it inherits the pm_app DML grant on an update —
-- REVOKE it so pm_app can never touch a control table. Guarded for safety.
-- (security_alert is the OPPOSITE — a DATA table that KEEPS the grant; its RLS
-- policies are in §5b.)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'notify_settings'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.notify_settings FROM pm_app';
  END IF;
END
$$;

-- browser_push_* are CONTROL tables for local dashboard Web Push configuration
-- and browser subscription endpoint/key material. They are owner-only and must
-- never be accessible to pm_app.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'browser_push_config'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.browser_push_config FROM pm_app';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'browser_push_subscription'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.browser_push_subscription FROM pm_app';
  END IF;
END
$$;

-- Graph v2 operational records are CONTROL tables. They inherit the default
-- pm_app grant above on a fresh migration, so revoke it every time RLS is
-- applied. The worker/updater writes them through ownerPrisma only.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'graph_usage_event'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.graph_usage_event FROM pm_app';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'graph_migration_run'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.graph_migration_run FROM pm_app';
  END IF;
END
$$;

-- local_identity is a CONTROL table (local-mode singleton pointer to the real
-- Team/AppUser rows). Same reasoning: created AFTER the ALTER DEFAULT PRIVILEGES,
-- so it inherits the pm_app DML grant on an update — REVOKE it so pm_app can never
-- touch a control table. Guarded for safety.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'local_identity'
  ) THEN
    EXECUTE 'REVOKE ALL ON public.local_identity FROM pm_app';
  END IF;
END
$$;

-- ── 3. GUC helper functions (per-request session vars set by runInTenant via
-- set_config with is_local=true == SET LOCAL). All use the 2-arg
-- current_setting(..., true) missing_ok form so an UNSET var fails CLOSED (NULL /
-- false → zero rows) instead of raising. SECURITY: owner-defined; STABLE.

-- Current user (author). NULL when unset → fails the ownership floor closed.
CREATE OR REPLACE FUNCTION pm_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- Current team (write target). NULL when unset → own-team predicates match none.
CREATE OR REPLACE FUNCTION pm_current_team_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.team_id', true), '')::uuid
$$;

-- Universal-read flag for the SHARED tables (docs/graph/etc.) — any authenticated
-- team member reads all. Fail-closed false.
CREATE OR REPLACE FUNCTION pm_can_read_all() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.can_read_all', true), ''), 'false') = 'true'
$$;

-- Teams the current team has MOUNTED (cross-team MEMORY reads), as a uuid[].
-- app.mounted_team_ids is a comma-separated list. Empty/unset → {}.
CREATE OR REPLACE FUNCTION pm_mounted_team_ids() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT array_agg(trim(x)::uuid)
       FROM regexp_split_to_table(
              NULLIF(current_setting('app.mounted_team_ids', true), ''),
              ',') AS x
      WHERE trim(x) <> ''),
    ARRAY[]::uuid[]
  )
$$;

-- Universal MEMORY read flag — set ONLY on the dashboard (a member's dashboard
-- view spans all teams, per users_roles.md). The MCP/data-plane leaves it false,
-- so MCP memory reads are own ∪ mounted. Fail-closed false.
CREATE OR REPLACE FUNCTION pm_read_all_memory() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.read_all_memory', true), ''), 'false') = 'true'
$$;

-- Global-admin write flag (dashboard super-admin cross-team). Fail-closed false.
CREATE OR REPLACE FUNCTION pm_is_global_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
$$;

-- Within-team owner-floor bypass (team-admin / super-admin). Fail-closed false.
CREATE OR REPLACE FUNCTION pm_bypass_owner_floor() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.bypass_owner_floor', true), ''), 'false') = 'true'
$$;

GRANT EXECUTE ON FUNCTION pm_current_user_id()    TO pm_app;
GRANT EXECUTE ON FUNCTION pm_current_team_id()    TO pm_app;
GRANT EXECUTE ON FUNCTION pm_can_read_all()       TO pm_app;
GRANT EXECUTE ON FUNCTION pm_mounted_team_ids()   TO pm_app;
GRANT EXECUTE ON FUNCTION pm_read_all_memory()    TO pm_app;
GRANT EXECUTE ON FUNCTION pm_is_global_admin()    TO pm_app;
GRANT EXECUTE ON FUNCTION pm_bypass_owner_floor() TO pm_app;

-- ── 4. The 9 SHARED data tables (docs/graph/etc.) — UNIVERSAL read.
-- These carry uploaded evidence + the derived graph; they are shared across all
-- teams (there is no point processing the same PRD twice). `memory` is NOT here —
-- it has its own own∪mounted read policy in §5.
-- Per-table policies (PERMISSIVE OR for reach; RESTRICTIVE AND as floors):
--   universal_read (PERMISSIVE SELECT) — any authenticated team member reads all.
--   team_write     (PERMISSIVE ALL)    — full access to OWN team's rows.
--   global_write   (PERMISSIVE ALL)    — super-admin dashboard cross-team writes.
--   write_floor    (RESTRICTIVE ALL)   — a written row must be the current team
--                                        unless the global-admin path is active.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'source','document','chunk','entity','claim','relationship',
    'investigation','investigation_link','ingest_job'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', t);

    -- Drop legacy + current policies before re-create (idempotent).
    EXECUTE format('DROP POLICY IF EXISTS own_team_all   ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS granted_read   ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_guard   ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS universal_read ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS team_write     ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS global_write   ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS write_floor    ON public.%I', t);

    -- PERMISSIVE SELECT: universal read for any authenticated team member.
    EXECUTE format($f$
      CREATE POLICY universal_read ON public.%I
        AS PERMISSIVE FOR SELECT TO pm_app
        USING (pm_can_read_all())
    $f$, t);

    -- PERMISSIVE ALL: full access to OWN team's rows; writes pinned to own team.
    EXECUTE format($f$
      CREATE POLICY team_write ON public.%I
        AS PERMISSIVE FOR ALL TO pm_app
        USING      (team_id = pm_current_team_id())
        WITH CHECK (team_id = pm_current_team_id())
    $f$, t);

    -- PERMISSIVE ALL: super-admin dashboard cross-team writes (any team).
    EXECUTE format($f$
      CREATE POLICY global_write ON public.%I
        AS PERMISSIVE FOR ALL TO pm_app
        USING      (pm_is_global_admin())
        WITH CHECK (pm_is_global_admin())
    $f$, t);

    -- RESTRICTIVE ALL floor: visible row must be readable (auth'd); a written row
    -- must be the current team unless the global-admin path is active. Even a
    -- buggy permissive policy can never write across the partition.
    EXECUTE format($f$
      CREATE POLICY write_floor ON public.%I
        AS RESTRICTIVE FOR ALL TO pm_app
        USING      (pm_can_read_all() OR pm_is_global_admin())
        WITH CHECK (team_id = pm_current_team_id() OR pm_is_global_admin())
    $f$, t);
  END LOOP;
END
$$;

-- ── 5. memory — own ∪ MOUNTED read (MCP) / universal (dashboard) + ownership floor.
-- Reads differ from the shared tables: a team member's MCP sees own team
-- (primary) ∪ mounted teams (additional), NOT all teams. The dashboard sets
-- app.read_all_memory=true to span all teams (per the role). Writes are
-- current-team only (mounts are read-only); a plain member may only UPDATE/DELETE
-- rows they created (the ownership floor; admins/super-admins bypass within team).
ALTER TABLE public.memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_team_all      ON public.memory;
DROP POLICY IF EXISTS granted_read      ON public.memory;
DROP POLICY IF EXISTS tenant_guard      ON public.memory;
DROP POLICY IF EXISTS universal_read    ON public.memory;
DROP POLICY IF EXISTS memory_read       ON public.memory;
DROP POLICY IF EXISTS team_write        ON public.memory;
DROP POLICY IF EXISTS global_write      ON public.memory;
DROP POLICY IF EXISTS write_floor       ON public.memory;
DROP POLICY IF EXISTS owner_floor_update ON public.memory;
DROP POLICY IF EXISTS owner_floor_delete ON public.memory;

-- (a) READ: own ∪ mounted ∪ (dashboard universal) ∪ (global super-admin).
CREATE POLICY memory_read ON public.memory
  AS PERMISSIVE FOR SELECT TO pm_app
  USING (
    pm_read_all_memory()
    OR pm_is_global_admin()
    OR team_id = pm_current_team_id()
    OR team_id = ANY (pm_mounted_team_ids())
  );

-- (b) team-bound write/update/delete (mounts are READ-only — not here).
CREATE POLICY team_write ON public.memory
  AS PERMISSIVE FOR ALL TO pm_app
  USING      (team_id = pm_current_team_id())
  WITH CHECK (team_id = pm_current_team_id());

-- (c) super-admin dashboard cross-team writes.
CREATE POLICY global_write ON public.memory
  AS PERMISSIVE FOR ALL TO pm_app
  USING      (pm_is_global_admin())
  WITH CHECK (pm_is_global_admin());

-- (d) RESTRICTIVE write floor: a visible row must be memory-readable; a written
-- row must be the current team unless the global-admin path is active.
CREATE POLICY write_floor ON public.memory
  AS RESTRICTIVE FOR ALL TO pm_app
  USING (
    pm_read_all_memory() OR pm_is_global_admin()
    OR team_id = pm_current_team_id() OR team_id = ANY (pm_mounted_team_ids())
  )
  WITH CHECK (team_id = pm_current_team_id() OR pm_is_global_admin());

-- (e) OWNERSHIP floor (RESTRICTIVE, split FOR UPDATE / FOR DELETE so SELECT is
-- untouched and INSERT is unaffected): a plain member may only modify rows they
-- created; team-admins/super-admins (bypass_owner_floor) and the global path pass.
CREATE POLICY owner_floor_update ON public.memory
  AS RESTRICTIVE FOR UPDATE TO pm_app
  USING      (pm_bypass_owner_floor() OR pm_is_global_admin() OR created_by_id = pm_current_user_id())
  WITH CHECK (pm_bypass_owner_floor() OR pm_is_global_admin() OR created_by_id = pm_current_user_id());

CREATE POLICY owner_floor_delete ON public.memory
  AS RESTRICTIVE FOR DELETE TO pm_app
  USING (pm_bypass_owner_floor() OR pm_is_global_admin() OR created_by_id = pm_current_user_id());

-- ── 5a. project_memory_binding — current user's Personal-stack binding only.
ALTER TABLE public.project_memory_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_memory_binding FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS binding_read ON public.project_memory_binding;
DROP POLICY IF EXISTS binding_write ON public.project_memory_binding;
DROP POLICY IF EXISTS binding_global_write ON public.project_memory_binding;
DROP POLICY IF EXISTS binding_floor ON public.project_memory_binding;

CREATE POLICY binding_read ON public.project_memory_binding
  AS PERMISSIVE FOR SELECT TO pm_app
  USING (user_id = pm_current_user_id() OR pm_is_global_admin());

CREATE POLICY binding_write ON public.project_memory_binding
  AS PERMISSIVE FOR ALL TO pm_app
  USING (user_id = pm_current_user_id() AND team_id = pm_current_team_id())
  WITH CHECK (user_id = pm_current_user_id() AND team_id = pm_current_team_id());

CREATE POLICY binding_global_write ON public.project_memory_binding
  AS PERMISSIVE FOR ALL TO pm_app
  USING (pm_is_global_admin())
  WITH CHECK (pm_is_global_admin());

CREATE POLICY binding_floor ON public.project_memory_binding
  AS RESTRICTIVE FOR ALL TO pm_app
  USING (user_id = pm_current_user_id() OR pm_is_global_admin())
  WITH CHECK (user_id = pm_current_user_id() OR pm_is_global_admin());

-- ── 5a. graph_lifecycle_operation — own-team commands or worker global path.
ALTER TABLE public.graph_lifecycle_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_lifecycle_operation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lifecycle_read ON public.graph_lifecycle_operation;
DROP POLICY IF EXISTS lifecycle_team_write ON public.graph_lifecycle_operation;
DROP POLICY IF EXISTS lifecycle_global_write ON public.graph_lifecycle_operation;
DROP POLICY IF EXISTS lifecycle_floor ON public.graph_lifecycle_operation;

CREATE POLICY lifecycle_read ON public.graph_lifecycle_operation
  AS PERMISSIVE FOR SELECT TO pm_app
  USING (team_id = pm_current_team_id() OR pm_is_global_admin());

CREATE POLICY lifecycle_team_write ON public.graph_lifecycle_operation
  AS PERMISSIVE FOR ALL TO pm_app
  USING (team_id = pm_current_team_id())
  WITH CHECK (team_id = pm_current_team_id());

CREATE POLICY lifecycle_global_write ON public.graph_lifecycle_operation
  AS PERMISSIVE FOR ALL TO pm_app
  USING (pm_is_global_admin())
  WITH CHECK (pm_is_global_admin());

CREATE POLICY lifecycle_floor ON public.graph_lifecycle_operation
  AS RESTRICTIVE FOR ALL TO pm_app
  USING (team_id = pm_current_team_id() OR pm_is_global_admin())
  WITH CHECK (team_id = pm_current_team_id() OR pm_is_global_admin());

-- ── 5a. graph episode provenance / delete previews — own-team or worker/global.
-- Provenance may survive the subject row so a later remove command can heal the
-- graph; previews are additionally constrained to the requesting dashboard user.
ALTER TABLE public.graph_episode_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_episode_provenance FORCE ROW LEVEL SECURITY;
ALTER TABLE public.graph_delete_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_delete_preview FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_provenance_read ON public.graph_episode_provenance;
DROP POLICY IF EXISTS graph_provenance_team_write ON public.graph_episode_provenance;
DROP POLICY IF EXISTS graph_provenance_global_write ON public.graph_episode_provenance;
DROP POLICY IF EXISTS graph_provenance_floor ON public.graph_episode_provenance;
CREATE POLICY graph_provenance_read ON public.graph_episode_provenance
  AS PERMISSIVE FOR SELECT TO pm_app
  USING (team_id = pm_current_team_id() OR pm_is_global_admin());
CREATE POLICY graph_provenance_team_write ON public.graph_episode_provenance
  AS PERMISSIVE FOR ALL TO pm_app
  USING (team_id = pm_current_team_id()) WITH CHECK (team_id = pm_current_team_id());
CREATE POLICY graph_provenance_global_write ON public.graph_episode_provenance
  AS PERMISSIVE FOR ALL TO pm_app
  USING (pm_is_global_admin()) WITH CHECK (pm_is_global_admin());
CREATE POLICY graph_provenance_floor ON public.graph_episode_provenance
  AS RESTRICTIVE FOR ALL TO pm_app
  USING (team_id = pm_current_team_id() OR pm_is_global_admin())
  WITH CHECK (team_id = pm_current_team_id() OR pm_is_global_admin());

DROP POLICY IF EXISTS graph_preview_read ON public.graph_delete_preview;
DROP POLICY IF EXISTS graph_preview_team_write ON public.graph_delete_preview;
DROP POLICY IF EXISTS graph_preview_global_write ON public.graph_delete_preview;
DROP POLICY IF EXISTS graph_preview_floor ON public.graph_delete_preview;
CREATE POLICY graph_preview_read ON public.graph_delete_preview
  AS PERMISSIVE FOR SELECT TO pm_app
  USING (requested_by_id = pm_current_user_id() OR pm_is_global_admin());
CREATE POLICY graph_preview_team_write ON public.graph_delete_preview
  AS PERMISSIVE FOR ALL TO pm_app
  USING (team_id = pm_current_team_id() AND requested_by_id = pm_current_user_id())
  WITH CHECK (team_id = pm_current_team_id() AND requested_by_id = pm_current_user_id());
CREATE POLICY graph_preview_global_write ON public.graph_delete_preview
  AS PERMISSIVE FOR ALL TO pm_app
  USING (pm_is_global_admin()) WITH CHECK (pm_is_global_admin());
CREATE POLICY graph_preview_floor ON public.graph_delete_preview
  AS RESTRICTIVE FOR ALL TO pm_app
  USING ((team_id = pm_current_team_id() AND requested_by_id = pm_current_user_id()) OR pm_is_global_admin())
  WITH CHECK ((team_id = pm_current_team_id() AND requested_by_id = pm_current_user_id()) OR pm_is_global_admin());

-- ── 5b. security_alert — own-team OR global-admin read (NOT universal).
-- A DATA table, but DELIBERATELY not in the §4 universal-read loop: a finding
-- reveals that a specific team holds sensitive data (even redacted), so a member of
-- team A must NOT read team B's alerts. Read = own team OR global super-admin; writes
-- are current-team (a team may resolve its own) OR the global-admin path (the
-- pii-scan worker / ingest block write cross-team via app.is_global_admin).
ALTER TABLE public.security_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_alert FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS universal_read ON public.security_alert;
DROP POLICY IF EXISTS alert_read     ON public.security_alert;
DROP POLICY IF EXISTS team_write     ON public.security_alert;
DROP POLICY IF EXISTS global_write   ON public.security_alert;
DROP POLICY IF EXISTS write_floor    ON public.security_alert;

-- (a) READ: own team OR global super-admin (NOT universal, NOT mounted).
CREATE POLICY alert_read ON public.security_alert
  AS PERMISSIVE FOR SELECT TO pm_app
  USING (pm_is_global_admin() OR team_id = pm_current_team_id());

-- (b) team-bound write (a team resolves its own alerts).
CREATE POLICY team_write ON public.security_alert
  AS PERMISSIVE FOR ALL TO pm_app
  USING      (team_id = pm_current_team_id())
  WITH CHECK (team_id = pm_current_team_id());

-- (c) super-admin / worker cross-team writes (the pii-scan job + ingest block).
CREATE POLICY global_write ON public.security_alert
  AS PERMISSIVE FOR ALL TO pm_app
  USING      (pm_is_global_admin())
  WITH CHECK (pm_is_global_admin());

-- (d) RESTRICTIVE floor: a visible row is own-team or global; a written row is the
-- current team unless the global-admin path is active. No universal read here.
CREATE POLICY write_floor ON public.security_alert
  AS RESTRICTIVE FOR ALL TO pm_app
  USING      (pm_is_global_admin() OR team_id = pm_current_team_id())
  WITH CHECK (pm_is_global_admin() OR team_id = pm_current_team_id());

-- ── 6. Verification canary. Run after applying; expects 15 rows, all with
-- relrowsecurity = t AND relforcerowsecurity = t. A NEW data table shipping
-- without RLS is ABSENT here — the drift canary. (Control tables team / app_user
-- / team_grant / local_identity / system_settings intentionally never appear.)
--
--   SELECT relname, relrowsecurity, relforcerowsecurity
--     FROM pg_class
--    WHERE relkind = 'r'
--      AND relname IN ('source','document','chunk','entity','claim',
--                      'relationship','investigation','investigation_link',
--                      'ingest_job','memory','security_alert',
--                      'project_memory_binding','graph_lifecycle_operation',
--                      'graph_episode_provenance','graph_delete_preview')
--    ORDER BY relname;
