# `@pm/shared`

The persistent-memory **reusable core**: the embedding adapter, the Qdrant
multi-tenant vector layer, the dimension/provider switch tool, and the ingest
infra — MinIO blob storage, the BullMQ ingest-queue contract, and text extraction
+ token-aware chunking. Consumed by `api` + `worker` — written once here so the
shared logic is never duplicated.

> **Prisma-FREE by design.** This package deals in plain bytes/streams,
> `number[][]` vectors, Qdrant payload objects, and string ids. It NEVER imports
> the Prisma client or reads Postgres — the Prisma clients live in `@pm/db`.
> Callers (api/worker/mcp) own the DB: they read rows, pass `{ teamId, project,
> rowId, text/vector }` (or a stream + key) into shared, and write the returned
> Qdrant point ids / object keys / job ids back to Postgres. This is what lets the
> worker/mcp depend on shared without a DB dependency.

## Subpath exports

```ts
import { makeEmbedderFromEnv } from '@pm/shared/embeddings'
import { ensureCollection, upsertVectors, searchVectors, assertActivePin } from '@pm/shared/qdrant'
import { runSwitch, planSwitch } from '@pm/shared/switch'
import { makeMinioClient, ensureBucket, putStream, originalKey } from '@pm/shared/storage'
import { makeIngestQueue, makeIngestWorker, enqueueIngest, type IngestJobData } from '@pm/shared/queue'
import { makeScheduledQueue, makeScheduledWorker, upsertSchedule, SCHEDULED_JOB_CATALOG } from '@pm/shared/queue'
import { extractText, chunkText } from '@pm/shared/extract'
import { type ActivePin, EmbeddingError } from '@pm/shared/types'
// or everything from the barrel:
import { makeEmbedderFromEnv, upsertVectors, extractText, makeIngestQueue } from '@pm/shared'
```

### Ingest infrastructure

- **`src/storage`** — MinIO S3 client (`resolveMinioConfig` parses the
  `MINIO_ENDPOINT` URL into host/port/SSL — the SDK wants those separate, NOT the
  full URL), `ensureBucket`, stream `putStream`/`getStream`/`getBuffer`, `statObject`,
  `presignedGetUrl`, `removeObject`, `removePrefix` (list+batch-remove every object
  under a prefix — document delete reclaims the original + untracked artifacts
  via `sourcePrefix`), `getBufferCapped` (stream a blob into a buffer with a
  HARD byte ceiling; aborts + throws `FileTooLargeError` past the cap so the worker
  can't OOM on an over-limit object). Object-key scheme is team-first:
  `team/<teamId>/<project>/<sourceId>/original|extracted/<safeName>`.
- **`src/queue`** — the BullMQ ingest contract: `INGEST_QUEUE` name, the
  `IngestJobData` payload (team server-derived at enqueue), `makeIngestConnection`
  (carries `maxRetriesPerRequest:null` — mandatory for workers), `makeIngestQueue` +
  `enqueueIngest` (producer, jobId === ingestJobId for idempotency), `makeIngestWorker`
  (consumer factory; the pipeline processor is injected by `worker/`). **Scheduled
  subsystem** (`src/queue/scheduled.ts`): a second queue `pm.scheduled` driven by
  BullMQ **job-schedulers** — `makeScheduledQueue`/`makeScheduledWorker`, the
  `upsertSchedule`/`removeSchedule`/`runScheduleNow`/`listSchedules` helpers, the
  `SCHEDULED_JOB_CATALOG` (single-sourced job metadata: name/description/defaultCron;
  includes the embedding and memory-graph backfill safety nets; the worker attaches
  `run()`, the api reads descriptions for the dashboard), and `WORKER_HEARTBEAT_KEY`
  (worker-liveness key shared by worker writer + api reader).
- **`src/extract`** — `extractText` (PDF via `unpdf`, docx via `mammoth`, txt/md
  UTF-8; pure-JS, no native deps) → `{ text, pages, artifacts, warnings }`, and
  `chunkText` (recursive separator split + token-aware greedy pack with overlap,
  `js-tiktoken` o200k_base, chars/4 fallback).

The fail-closed DLP client/gate moved to `@pm/security-dlp` under
`layers/security-dlp`; API and worker consumers import it from that capability
layer instead of the generic reusable core.

## Embedding adapter (`src/embeddings`)

One interface, `number[][]` in/out, order-preserving, batched, with retry/backoff
and actionable errors:

```ts
interface Embedder {
  readonly provider: 'ollama' | 'voyage' | 'openai'
  readonly model: string
  readonly dim: number
  readonly vectorName: string          // "<slug>__<dim>", the Qdrant named-vector key
  embed(texts: string[], kind?: 'document' | 'query'): Promise<EmbedResult>
}
```

| Provider | Model | Native dim | Dim selection |
|---|---|---|---|
| ollama | `qwen3-embedding:4b` (default) | 2560 | Matryoshka 2560/1024/768/512/256 |
| ollama | `qwen3-embedding:0.6b` (CPU-friendly alt) | 1024 | 1024/768/512/256 |
| ollama | `nomic-embed-text` (fallback) | 768 | fixed |
| voyage | `voyage-3-large` | 1024 | `output_dimension` 256/512/1024/2048 (asymmetric) |
| openai | `text-embedding-3-large` | 3072 | `dimensions` any ≤ 3072 |
| openai | `text-embedding-3-small` | 1536 | `dimensions` any ≤ 1536 |

- **`EMBED_PROVIDER` is the concrete backend** (`ollama | voyage | openai`). It is a
  DIFFERENT axis from `EMBEDDING_MODE` (`server | client-bridge`, server-managed embeddings vs client-managed embeddings),
  which the Qdrant write path consumes. Do not conflate them.
- **`kind` matters only for Voyage** (asymmetric: `'document'` for stored vectors,
  `'query'` for the search query). ollama/openai ignore it.
- **Ollama uses the modern `/api/embed`** (plural, accepts a string array →
  `{ embeddings }`), never the legacy singular `/api/embeddings`.
- Config from `EMBED_PROVIDER` / `EMBED_MODEL` / `EMBED_DIM` (+ `OLLAMA_URL`,
  `VOYAGE_API_KEY`, `OPENAI_API_KEY`, optional `EMBED_BATCH_SIZE` /
  `EMBED_MAX_RETRIES` / `EMBED_TIMEOUT_MS`). `resolveEmbedConfig()` validates the
  `(provider, model, dim)` triple at boot and fails fast.

> Graphiti has its own (Python) node/edge embedder — **out of scope**. This adapter
> is only for Qdrant Chunk/Memory vectors.

## Qdrant layer (`src/qdrant`)

ONE collection `memory_vectors` using **named vectors** keyed by `"<slug>__<dim>"`.
`team_id` is a payload field with a tenant payload index (`is_tenant: true`);
`project` is a secondary keyword index.

- `ensureCollection(client, pin)` — idempotent; create-if-absent + payload indexes.
- `upsertVectors(client, { teamId, pin, items })` — `team_id` is **server-stamped
  from identity, never a client arg**; returns `rowId → pointId` for write-back.
- `searchVectors(client, { queryVector, pin, readableTeamIds, project?, limit? })`
  — `Filter.should` OR over `readableTeamIds` (tenant-OR), using the **active**
  named vector. Empty scope → fail-closed (no rows). Own-team-primary ordering is
  the caller's merge job.
- `assertActivePin(declared, active)` — the **client-managed embeddings guard**: rejects a precomputed
  vector whose declared `(modelId, dim)` ≠ the active pin (`ModelDimMismatchError`,
  → 422 at the api). In server-managed embeddings the server embeds with the pin by construction.

> The "active vector" is **config, not Qdrant state** — held in `EMBED_MODEL/DIM`
> (server-managed embeddings) / the System Settings row (runtime). The collection just contains
> one or more named vectors; the active one is `vectorName(activeModel, activeDim)`.

## Switch tool (`src/switch`)

Zero-downtime named-vector migration (dimension/provider change). Rollback = revert
the active pointer; the old vector survives until the explicit drop.

1. **add** — `createVectorName` registers the target named vector (schema only, no copy).
2. **dual-write** — a caller-held flag; new writes embed with both models.
3. **re-embed** — scroll all points, re-embed from Postgres source text (caller
   `fetchText`), write the target vector via `updateVectors`.
4. **flip** — caller swaps the active pin (a config/DB write — instant, reversible).
5. **drop** — `deleteVectorName` removes the old vector (point of no return).

`runSwitch(client, plan, hooks)` sequences these with `noFlip` / `noDrop` /
`onProgress` hooks; each Qdrant step is idempotent (resume-safe).

The api drives this end-to-end from `PUT /dashboard/settings`
(`apps/api/src/services/model-switch.ts`) as a no-blackout, no-restart, dashboard-driven
re-embed. It runs the tool with `noDrop` (add→backfill→flip) then a second
`step3Reembed` pass + `step5DropOld`, so flip-window writes are reconciled WITHOUT a
live dual-write path (`setDualWrite` is left a no-op). `makeEmbedderForPin(model, dim)`
builds the target embedder + the live-pin path's embedder (provider from the registry,
not `EMBED_*`).

> In `@qdrant/js-client-rest` v1.18 the vector name + config
> are POSITIONAL — `createVectorName(collection, name, { dense: { size, distance } })`
> and `deleteVectorName(collection, name)`. `updateCollection` does NOT add a named
> vector (it only tweaks hnsw/quantization of existing ones).

### CLI

```sh
# from the workspace root:
npm run switch -- --to-provider ollama --to-model nomic-embed-text --to-dim 768 \
  [--from-model qwen3-embedding:0.6b --from-dim 1024] [--no-flip] [--no-drop] [--page 256]
```

The CLI proves the Qdrant migration mechanics and supports dry-style runs
(`--no-flip` / `--no-drop`). It cannot read Postgres (shared is DB-free), so the
real re-embed-from-text path is driven by the worker/admin calling `runSwitch`
with a concrete `fetchText`.

## Build / test

```sh
npm run build      -w @pm/shared     # composite tsc → dist/ (.js + .d.ts)
npm run typecheck  -w @pm/shared     # tsc --noEmit
npm run test       -w @pm/shared     # vitest (registry/naming/guard/config matrix)
```

`tsconfig.json` is `composite: true` + `declaration: true` with `rootDir: "src"`
(legal here — shared has no out-of-tree sibling like the api's generated client),
and uses `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` so the
`.ts`-suffixed source imports emit as `.js` in both the JS and the `.d.ts`.
