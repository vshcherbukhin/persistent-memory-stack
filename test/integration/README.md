# Live integration suite

A repeatable, **pure-HTTP** end-to-end test suite that runs only against an
**isolated disposable DEV stack**. It provisions everything (teams, users, tokens,
grants) through the real dashboard API, so it also exercises the control plane — no
`@pm/db`, no `argon2`, no direct DB access.

## Prerequisites

1. Start the disposable stack once: `npm run dev-test:up`. It creates only
   `.local/dev-test-stack/`, its namespaced Docker resources, and a test-only
   bootstrap token. It never reads `.env.persistent-memory` or its volumes.
2. Put a **scoped test provider key** in `.local/dev-test-stack/.env`:
   `ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY=...`, matching
   `EXTRACTION_PROVIDER`. This keeps live write validation real without copying
   personal installation credentials into the test stack.

## Run

```bash
npm run dev-test:up
# add the scoped provider key to .local/dev-test-stack/.env
npm run dev-test:run
npm run dev-test:down  # removes only the disposable test resources
```

`npm run test:integration` runs `vitest run --config test/integration/vitest.config.ts`.
It is intentionally **NOT** part of the default `npm test` (that one needs no live
stack). The suite runs **sequentially** (single fork, no isolation) because the
specs hit shared live state.

> **Safety gate:** this suite changes teams, users, memory rows, worker schedules,
> and the active embedding pin. It requires both explicit process flags and an API
> `/config` response marked `testStack:true` in server mode. A personal or shared
> installation cannot satisfy that preflight. Its API-only teardown follows the
> dashboard's per-memory graph-impact confirmation flow.

## What it covers

| Spec | Scenario |
|---|---|
| `memory-crud.test.ts` | Member token: create a Shape-passing memory (Mode A server-embeds) → semantic search finds it → PATCH content, search reflects the new content with **no stale/duplicate hit** → DELETE → 404. |
| `rls-isolation.test.ts` | Teams A + B each with a member + memory. A's search returns A but **not** B (own ∪ mounted). Then **B grants A** (mount) → A's MCP-scope search now **also** returns B, tagged `isOwnTeam:false`. |
| `security-gates.test.ts` | a plain member's `universal:true` on `POST /memories/search` **and** `GET /memories?universal=true` is **ignored** (no cross-team leak); a **team-admin** importing into another team via `/dashboard/memories/import` is **rejected** per-record (`cross_team_read_only`, `imported=0`), while a **super-admin** succeeds (`imported=1`). |
| `ingest-doc.test.ts` | `POST /ingest` a small text file (multipart) → poll `GET /ingest/:jobId` until `completed` → assert `graphStatus` ∈ {pending, ok, failed, skipped} → `POST /documents/search` finds the chunk. |
| `scheduled-jobs.test.ts` | `GET /dashboard/workers` lists `usage-sweep` + worker liveness; a plain member can **read** but not **mutate** (run-now → 403); `run-now` (superuser) drives the worker → status flips to `success` with a fresh `lastRunAt`; `pause`/`resume` toggle the next-run; schedule CRUD via `PUT` persists a new cron and rejects an invalid one (`400 invalid_cron`). The `embed-backfill` job is registered; `GET /dashboard/memories/pending` returns the pending counts + mode; `run-now` (superuser) completes successfully; a plain member's run-now → 403. |

## Helpers

- `client.ts` — `api(method, path, {token?, body?, query?})` → `{status, json}`;
  `apiMultipart(...)` for `/ingest`; `poll(fn, predicate, opts)` for async jobs.
- `provision.ts` — `createTeam`, `createUser`, `issueToken`, `setAdminLevel`,
  `createGrant`, `provisionTeamWithMember`, and best-effort teardown helpers.

## Caveats for a live run

- **Memory writes call the extraction LLM** (`validateAndRoute` Stage 2 — Haiku
  with a cloud key, or local Ollama). If that backend is unreachable, `POST
  /memories` returns **500**, not 422. The test content is crafted to pass both
  the deterministic pre-gate and a sane `accept` verdict; a noisy local model
  *could* return `restructure` — the CRUD spec tolerates that (it asserts the new
  content is searchable, not byte-equality), but if the model rejects valid
  content the create assertions will fail. Use a real key for the most faithful run.
- **Ingest needs the worker + MinIO + Qdrant + the embedder** all healthy. The
  poll timeout is 50s; a cold stack may need longer — bump `timeoutMs` in
  `ingest-doc.test.ts` if needed.
- **Teardown is best-effort.** Teams that received ingested documents cannot be
  auto-deleted (the team-delete probe refuses non-empty teams); those team rows
  linger harmlessly. Memory-only specs clean up fully. Names/emails carry a unique
  suffix so reruns don't collide.
