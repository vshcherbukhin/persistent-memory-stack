# persistent-memory-prisma

The schema, the RLS policy file, the migrations, and the seed.

- **`schema.prisma`** — the data model (teams, users, the local-identity singleton, memories, documents/sources/chunks, claims,
  entities, investigations, scheduled jobs, security alerts, system settings). Prisma 7: the
  datasource URL lives in `prisma.config.ts`, not the schema; the generator emits **TypeScript** to
  `generated/prisma/` (gitignored).
- **`rls.sql`** — the Row-Level Security policies + the `pm_app` grants/revokes. Idempotent
  (DROP/CREATE). This is the security backstop the api/worker rely on; new **control** tables must
  `REVOKE pm_app` here (a .claude/CLAUDE.md gotcha).
- **`../../../deploy/scripts/apply-rls.sh`** — applies `rls.sql` through the running
  `persistent-memory-postgres` container, preserving
  `PGOPTIONS="-c pm.app_password=..."`. The installer/updater use this helper so
  laptops do not need a host `psql`.
- **`migrations/`** — `0001_init` … `0030` (the latest add provenance, retention, the embedding
  switch, document lifecycle/dedup, account/notify fields, local identity, usage actors,
  fact-extraction settings, memory-level Graphiti sync state, MCP idle timeout, shared
  connection fields, browser Web Push control tables, and additive Graph v2 episode
  provenance/lifecycle/migration records, retire automatic archive, remove
  the unused manual-memory-verification override, and add the user-visible
  `record_updated_at` clock plus graph/list read indexes).
- **`seed.ts`** — bootstraps a team-less global super-admin.

## Architecture deep-dive

→ **[documentation/components/db.md](../../../documentation/components/db.md)** and
**[documentation/stack-architecture/access-model.md](../../../documentation/stack-architecture/access-model.md)** (how the GUCs encode the access model).

## Apply

```bash
npm run prisma:generate    # regenerate the client
# migrations are applied by the installer/updater;
# rls.sql is applied in the Postgres container as the DB owner with
# PGOPTIONS="-c pm.app_password=…" (psql-18 gotcha).
npm run rls                # apply rls.sql        (from layers/core/schema/)
npm run rls:check          # verify the RLS floor (from the repo root; loads .env.persistent-memory)
```

Migrations and RLS are applied by the installer/updater inside the Postgres
container so laptops do not need a host `psql`.
