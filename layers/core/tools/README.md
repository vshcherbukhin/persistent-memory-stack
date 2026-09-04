# persistent-memory tools

Dev-only CLIs for the `persistent-memory` stack. **Not shipped in any server image** — `layers/core/tools/` is a workspace member so its CLIs can call the *real* `@pm/db` (`runInTenant`, RLS) and `@pm/shared` (the pinned embedder + Qdrant layer).

| Tool | What it does |
|---|---|
| `rls-check.mjs` | The RLS floor verifier (`npm run rls:check`) — asserts the row-level-security policies hold for the `pm_app` role. Loads `DATABASE_URL` and `DATABASE_MIGRATE_URL` from `.env.persistent-memory` when they are not already exported, rewriting the Compose Postgres hostname to the host port for local checks. |

---

## `rls-check.mjs` — the RLS floor verifier

Run from the workspace root against a live stack:

```bash
npm run rls:check
```

It connects as `pm_app` (the `NOSUPERUSER`/`NOBYPASSRLS` data-plane role) and asserts the row-level-security policies enforce the access model — own ∪ mounted memory reads, universally-shared documents/graph, team-bound writes, and the ownership floor. A failing assertion means an RLS policy regressed.

---

## Build / typecheck

`layers/core/tools/` is an npm workspace member depending on `@pm/db` + `@pm/shared` (consumed as built packages — run `npm run build:shared && npm run build:db` first if `dist/` is stale).
