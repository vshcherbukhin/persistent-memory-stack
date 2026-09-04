# persistent-memory-api

The **Fastify HTTP API** — and the system's **single authorization choke-point**. Identity is
derived server-side from the Bearer token (the client asserts nothing); every data-plane query runs
inside `runInTenant(...)` so Postgres RLS applies as the backstop.

It owns: auth/identity, the memory protocol + Shape A–E gate + the fail-closed DLP/PII gate + the
provenance rerank, ingest, graph/document/investigation routes, the bounded metadata-only
Memory Graph read model (`/graph/snapshot`, `/graph/facets`, and `/graph/activity`), the canonical `/dashboard/*`
control + dashboard planes (`/admin/*` remains a one-release compatibility alias), the embedding
pin + dashboard-driven model switch, System Settings probes for
embedding/fact extraction, safe model-dependency health observations, and the
`DEPLOYMENT_MODE=local` no-auth path. Endpoints map 1:1 to the MCP tools.
Memory Graph fact snapshots use temporal-key/UUID continuation, activity bursts
drain a fixed bounded window, and facet searches target one section at a time.

Model-dependency health is a separate owner-only control record for Fact extraction,
Embeddings, and host Ollama. It uses canonical redacted error codes and
`healthy | degraded | unhealthy | unknown`; an actual later success or green
Settings test clears the matching failure. The API returns the same safe DTO to
Dashboard Overview, Services, Settings, and Token usage. Client-managed embedding
observations are scoped from the authenticated identity, never supplied by the
MCP client.

## Architecture deep-dive

→ **[documentation/components/api.md](../../documentation/components/api.md)** (modules, endpoint→MCP-tool map, the auth spine).
Related: [ACCESS-MODEL](../../documentation/stack-architecture/access-model.md) · [SECURITY](../../documentation/stack-architecture/security.md) ·
[INGEST](../../documentation/stack-architecture/ingest.md) · [EMBEDDING](../../documentation/stack-architecture/embedding.md).

## Run / test

```bash
npm run build:api          # from the repo root (tsc -b, reference-aware)
npm run typecheck:api
npm test -w persistent-memory-api
```

The api connects to Postgres as **`pm_app`** (`NOSUPERUSER`/`NOBYPASSRLS`) for data and to
`ownerPrisma` (pmuser) only for control tables — see [`@pm/db`](../../packages/db/README.md). It is built and run
via Docker (`deploy/compose/docker-compose.yml`); for local iteration against the live containers, see the build/run
notes in `.claude/CLAUDE.md`.
