# persistent-memory-worker

The **BullMQ consumer**. Two responsibilities:

1. **Document ingestion pipeline** — bounded read (`getBufferCapped` + a container `mem_limit`) →
   extract → fail-closed DLP scan → content-hash dedup / version-in-place → chunk → embed → Qdrant
   upsert → Graphiti episode.
2. **The managed scheduled-worker subsystem** — 6 jobs (`usage-sweep`, `embed-backfill`,
   `memory-graph-backfill`, `graph-lifecycle`, `ingest-reconciler`, `pii-scan`) driven by BullMQ job-schedulers and reconciled
   from the durable `ScheduledJob` table on boot + every dashboard mutation. The 15s liveness
   heartbeat is deliberately a `setInterval`, not a scheduled job.

Cross-team maintenance jobs use the sanctioned global-admin RLS path (`withSystemTenant` +
`runInTenant({ globalAdmin: true })`), never `ownerPrisma` on data tables.

Server-managed embedding calls also emit best-effort `embeddings/server` health
observations with only canonical safe quota/rate-limit/unavailable/model/timeout
diagnostics. This is independent of the existing `IngestJob` failure/retry record:
health telemetry never changes a job outcome, and a successful real embedding
operation clears the active health failure.

## Architecture deep-dive

→ **[documentation/components/worker.md](../../documentation/components/worker.md)**.
Related: [INGEST](../../documentation/stack-architecture/ingest.md) · [EMBEDDING](../../documentation/stack-architecture/embedding.md) ·
[SECURITY](../../documentation/stack-architecture/security.md).

## Run / test

```bash
npm run build:worker       # from the repo root
npm run typecheck:worker
npm test -w persistent-memory-worker
```

Runs as a Docker service (`deploy/compose/docker-compose.yml`) with `mem_limit=${WORKER_MEM_LIMIT:-1g}` and
`WORKER_CONCURRENCY` (default 2). It polls `SystemSettings` every 10s to rebuild its embedder when the
model pin changes (see [EMBEDDING](../../documentation/stack-architecture/embedding.md)).
