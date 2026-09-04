# @pm/db

The data-access layer: the two Prisma clients + the RLS tenant wrapper. The **only** workspace member
that imports the generated Prisma client.

- **`prisma`** — the `pm_app` client (`NOSUPERUSER`/`NOBYPASSRLS`) for all data-plane work.
- **`ownerPrisma`** — the `pmuser` client (Postgres **superuser**, so it *bypasses* RLS); confined to
  control tables (`team`/`app_user`/`local_identity`/`system_settings`) + migrate/seed.
- **`runInTenant(fn, opts?)`** — opens one interactive transaction and sets the per-request `app.*`
  GUCs (`SET LOCAL`, bind-param) that the RLS policies in `layers/core/schema/rls.sql` read. Widening access is
  always a policy reading a GUC, never a role bypass; `opts.globalAdmin` is re-checked against the ctx.
- **`guardedPrisma`** — throws if a data model is touched outside a tenant scope (don't defeat it).
- The tenant **AsyncLocalStorage** carries the request ctx; `getCtx()` reads it (throws if unscoped).

## Architecture deep-dive

→ **[documentation/components/db.md](../../documentation/components/db.md)**.
Related: [ACCESS-MODEL](../../documentation/stack-architecture/access-model.md) (the GUC → RLS-policy table) ·
[`layers/core/schema/`](../../layers/core/schema/README.md) (schema + `rls.sql` + migrations).

## Build / test

```bash
npm run prisma:generate    # regenerate the client (needed before any build)
npm run build:db
npm run typecheck:db
```
