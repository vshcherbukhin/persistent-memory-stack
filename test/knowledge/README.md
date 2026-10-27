# Isolated personal-knowledge verification

This suite intentionally refuses normal database ports and requires an explicit
task marker. Never point it at the installed stack: fixtures include corrections,
deletions and archive restoration using a database-owner connection.

1. Restore a consistent supported baseline backup into disposable PostgreSQL17
   resources with no user-volume mounts. Create the runtime role before restoring:
   a database archive does not contain cluster-wide roles.
2. On that isolated copy, apply `migration-ownership-fixture.sql` before migrations
   0031–0033. It adds four synthetic rows covering owned, foreign, unknown and
   cached-remote ownership. Preserve the original logical-row reconciliation.
3. Set the database marker `pm.task=community-knowledge-01a17e67`, deploy migrations
   through Prisma, then apply RLS with the isolated `pm.app_password` setting.
   Record the migration, policy and interrupted-transaction evidence.
4. Supply `PM_TEST_STACK=true`, `PM_KNOWLEDGE_TEST_DATABASE_URL` (runtime role),
   `PM_KNOWLEDGE_TEST_OWNER_URL` (owner role), and a fixture-only `TOKEN_PEPPER`.
   Use an unused checked loopback port distinct from5432/5433. On Windows use a
   writable repository-local `TEMP`/`TMP` for the test runner.
5. Build shared/database packages and run
   `npx vitest run --config test/knowledge/vitest.config.ts` from the repository root.

The suite uses a deterministic clean DLP stub and no content-validation model call.
It proves the canonical database/HTTP boundaries, not live model quality, actual
Codex/Claude acceptance, rendered dashboard behavior or full-store updater safety.
Keep those evidence categories separate. Inspect resource labels/mounts and save
receipts before stopping only the task-owned disposable containers.
