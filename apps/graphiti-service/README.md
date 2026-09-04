# persistent-memory-graphiti

API-trusted **Python/FastAPI temporal-graph microservice** for the
`persistent-memory` stack. Wraps [`graphiti-core`](https://github.com/getzep/graphiti)
to expose a small, stable HTTP surface for bi-temporal fact storage, cross-team
search, timelines, and contradiction tracking.

The TypeScript `persistent-memory-api` / `-worker` are the intended callers over
the private compose network (`persistent_memory_network`). For local operations,
Compose also publishes **8100** on `PM_HOST_BIND` (default `127.0.0.1`) so the
Services page can link to `/docs`. Do not expose that host port publicly.

---

## The trust model — this service does NO auth

This service has **no authentication and no authorization**. It trusts every
`group_id` the API passes. The **API is the choke-point**: it validates the
user's token, derives identity, resolves authorized named project partitions from
team membership, grants, and memory-surface bindings, and supplies the right
`group_id`(s) on every call. Graphiti never sees
a token.

> **`group_id` is an opaque surface/team/project partition.** The API derives it;
> the graph service never receives a raw project selector or user identity.
> - **Writes** (`POST /episodes`) take exactly **one** `group_id`. There is no
>   array — so there is no request shape that can write across teams. This is the
>   structural enforcement of *"writes never cross teams."*
> - **Reads** (`POST /search`, `GET /timeline`, `GET /contradictions`) take
>   `group_ids: list[str]` for explicitly named, authorized project partitions. `min_length=1` is
>   enforced so an empty list — which would otherwise match everything — is
>   rejected. The service does **not** decide visibility; it trusts the list.

With the FalkorDB backend, graphiti-core uses a provided opaque `group_id` as the
FalkorDB graph/database name. The Browser may open on `default_db`, which can show
schema labels/index metadata but no records; do not expose partition keys to agents.

The host-published OpenAPI docs and health port is loopback-only by default. Do not set
`PM_HOST_BIND=0.0.0.0` for this stack unless the host is behind a trusted
firewall/reverse proxy.

---

## The embedder is ALWAYS server-side (do not confuse with Mode A/B)

Graphiti embeds **its own graph nodes/edges** server-side via the embedder
configured here (`EMBED_PROVIDER` / `EMBED_MODEL` / `EMBED_DIM`).

This is **independent of** the Mode A / Mode B *client-bridge* toggle
(`EMBEDDING_MODE`), which governs **Qdrant chunk vectors** in the TypeScript
side only. `EMBEDDING_MODE` is intentionally **not** read by this service.

In **Mode B** (server runs no chunk embedder), the recommended Graphiti embedder
is still cloud (Voyage / OpenAI) or a small server Ollama — graph nodes are few,
so the cost is negligible.

---

## Endpoints

| Method & path | Purpose | Tenancy param |
|---|---|---|
| `GET /healthcheck` | Liveness; reports backend + embedder + dim. Matches the compose probe on `:8100/healthcheck`. | — |
| `POST /episodes` | `add_episode` — extract entities/facts from text, store them, supersede contradicted facts. Returns the created episode, nodes, edges, and (diagnostic) `invalidated_edges`. | one `group_id` (write) |
| `DELETE /episodes` | V2 contract: verify and remove one persisted `{group_id, episode_uuid}` through `Graphiti.remove_episode`, which cascades episode-primary facts and orphaned entities. The service retains a temporary `{group_id, name}` compatibility path only for writers that predate stored episode provenance. | one `group_id` (write) |
| `POST /search` | Hybrid relevance search across one or more teams in a single call. | `group_ids[]` (read) |
| `GET /timeline` | Deterministic chronological fact stream ordered by temporal key + UUID, with optional `after_at` / `after_uuid` keyset continuation and validity windows. Not relevance-ranked. | `group_ids[]` (read) |
| `GET /contradictions` | Superseded facts (`invalid_at IS NOT NULL`), each paired with the newer fact that replaced it. | `group_ids[]` (read) |

### Bi-temporal model (the one fact to internalize)

Every entity "fact" edge carries **two independent time axes**:

| Axis | Fields | Meaning |
|---|---|---|
| **Event / validity time** | `valid_at`, `invalid_at` | When the fact was true *in the world*. `invalid_at IS NULL` ⇒ still true. `invalid_at NOT NULL` ⇒ superseded/expired. |
| **System / ingestion time** | `created_at`, `expired_at` | When Graphiti *learned / un-learned* the fact. |

`/timeline` and `/contradictions` filter on **`invalid_at`** (event-time), **not**
`expired_at` (system-time).

**There is no `invalidate` endpoint.** Invalidation is a **side effect** of a
later, contradicting `add_episode`: when a new episode's fact contradicts an
existing edge between the same entity pair, graphiti-core stamps the older edge's
`invalid_at` from the **new episode's `reference_time`** and opens a new edge
with `valid_at = reference_time`. The old edge is kept (not deleted) — that is
what makes timelines and contradiction history survive.

> **`reference_time` is the lever.** A contradicting episode supersedes an
> earlier fact only if its `reference_time` is strictly later. An expiry stated
> directly in the text ("valid until 2026-03-01") also sets `invalid_at`, with
> no replacing fact (`superseded_by = null`).

### Examples

```bash
# Write a fact for team_a
curl -sX POST localhost:8100/episodes -H 'content-type: application/json' -d '{
  "group_id": "team_a",
  "name": "ep1",
  "episode_body": "TC_6596 runs on the staging environment.",
  "source": "text",
  "reference_time": "2026-01-01T00:00:00Z"
}'

# Write a later, contradicting fact for the same team
curl -sX POST localhost:8100/episodes -H 'content-type: application/json' -d '{
  "group_id": "team_a",
  "name": "ep2",
  "episode_body": "TC_6596 now runs on the production environment, no longer staging.",
  "source": "text",
  "reference_time": "2026-02-01T00:00:00Z"
}'

# Contradictions: the staging fact now has invalid_at == 2026-02-01
curl -s 'localhost:8100/contradictions?group_ids=team_a'

# Timeline: both edges, ascending valid_at (staging [t0->t1], production [t1->open])
curl -s 'localhost:8100/timeline?group_ids=team_a'

# Cross-team search: facts from BOTH teams in one call, each carrying its group_id
curl -sX POST localhost:8100/search -H 'content-type: application/json' -d '{
  "query": "TC_6596", "group_ids": ["team_a","team_b"], "limit": 10
}'
```

---

## Configuration (env)

All config comes from the process environment (compose-injected; see
`../../deploy/compose/docker-compose.yml` `graphiti` block and `../../.env.persistent-memory`).

| Env var | Default | Purpose |
|---|---|---|
| `GRAPH_BACKEND` | `falkordb` | `falkordb` (primary) \| `neo4j` (switchable) — picks the driver |
| `FALKORDB_HOST` | `persistent-memory-falkordb` | container name |
| `FALKORDB_PORT` | `6379` | **internal** port (host map is 6380 — never use 6380 container-to-container) |
| `FALKORDB_USERNAME` / `FALKORDB_PASSWORD` | — / generated | FalkorDB auth; browser login uses user `default` with this password |
| `FALKORDB_DATABASE` | `default_db` | FalkorDB graph/db name |
| `FALKORDB_QUERY_TIMEOUT_MS` | `5000` | bounded FalkorDB read-query budget; Graphiti caps full-text candidates to 12 terms and falls back to vector/BFS/exact resolution if that optional signal times out |
| `NEO4J_URI` | `bolt://persistent-memory-neo4j:7687` | bolt, internal port 7687 (host 7688) |
| `NEO4J_USER` / `NEO4J_PASSWORD` | `neo4j` / `persistentmemory` | from `NEO4J_AUTH` |
| `NEO4J_DATABASE` | `neo4j` | Neo4j database name |
| `EXTRACTION_PROVIDER` | `anthropic` | `anthropic` \| `openai` |
| `EXTRACTION_MODEL` | `claude-haiku-4-5-20251001` | extraction LLM model id |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | same extraction LLM credentials used by fact extraction; Anthropic `sk-ant-oat...` tokens are sent as OAuth Bearer with the required beta header |
| `EMBED_PROVIDER` | `ollama` | `ollama` \| `openai` \| `voyage` (server-side embedder) |
| `EMBED_MODEL` | `qwen3-embedding:4b` | graph-node embedding model |
| `EMBED_DIM` | `2560` | embedding dimension |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | host Ollama; the service appends `/v1` |
| `VOYAGE_API_KEY` | — | only if `EMBED_PROVIDER=voyage` |
| `SEMAPHORE_LIMIT` | `10` | concurrent LLM/embed cap (429 throttle). Read by graphiti-core from the env at init — set before the app starts; changing it needs a restart. Tune by tier: OpenAI T1 ~1-2 / T3 ~10-15; Anthropic mid ~10. |

### Switching the graph backend

```bash
# default — FalkorDB (no extra services)
docker compose up -d graphiti

# Neo4j — start the profile-gated service AND set the backend env
GRAPH_BACKEND=neo4j docker compose --profile neo4j up -d neo4j graphiti
```

`Neo4jDriver` ships in `graphiti-core` base deps — there is no `[neo4j]` extra.
The `NEO4J_*` env is wired into the `graphiti` block so the swap connects.

---

## Notes / gotchas

- **Port 8100, not 8000.** Upstream `graph_service`/uvicorn defaults to 8000.
  The `Dockerfile` `CMD` pins `--port 8100`; the compose healthcheck probes 8100.
- **App layout is flat** (`main.py`, `config.py`, `graph.py`, `models.py` at the
  service root). The Dockerfile runs `uvicorn main:app` over a flat `COPY . /app`
  — this is **this** service's app, not upstream `graph_service.main:app`.
- **`invalidated_edges` is derived, diagnostic, best-effort.** graphiti-core
  0.29.2 `AddEpisodeResults` has no `invalidated_edges` field, so the response
  re-fetches edges between the touched node pairs and reports those with
  `invalid_at` set. A driver hiccup here never fails the write.
- **`/timeline` & `/contradictions` use raw Cypher** (`driver.execute_query`) on
  the `:RELATES_TO` edges, ordered by temporal key plus UUID. `/timeline` returns
  `next_after_at` / `next_after_uuid` keyset state — complete + deterministic,
  unlike `search()` which is recall-capped by `num_results`. Backend-agnostic:
  both FalkorDB and Neo4j speak Cypher.
- **`reference_time` is coerced to tz-aware UTC.** graphiti-core compares
  datetimes; naive datetimes misbehave.
- **Graphiti uses the same extraction token/model as fact extraction.** The
  service reads `EXTRACTION_PROVIDER`, `EXTRACTION_MODEL`, and the matching
  provider key from the shared env. Anthropic OAT credentials use the same
  Bearer + `oauth-2025-04-20` path as the TypeScript fact-extraction client.
  Anthropic Python SDK 1.x no longer accepts `temperature`, `top_p`, or `top_k`
  as `messages.create()` keyword arguments. Graphiti 0.29.2 still forwards
  those sampling controls, so the service strips them at its Anthropic client
  boundary before sending a request; all other request fields and usage
  telemetry remain unchanged.
- **FalkorDB full-text compatibility and timeout fallback are patched locally.**
  Graphiti 0.29.2 can leave punctuation from arbitrary memory content in its
  RediSearch filters and turns every word of a verbose extracted fact into an
  OR clause. The service patches the base FalkorDB driver (including Graphiti's
  per-project driver clones) and its episode-extraction operations path with one
  allow-list sanitizer: letters and numbers remain search terms; every
  punctuation character becomes whitespace. It keeps at most 12 unique lexical
  terms per query. Code-formatted text such as `` `options.filter` ``, URLs,
  operators, and verbose facts therefore cannot turn into pathological
  full-text reads. FalkorDB retains a bounded 5-second read timeout by default
  (`FALKORDB_QUERY_TIMEOUT_MS`); if that optional BM25 signal still times out,
  Graphiti continues with its vector/BFS/exact-node hybrid candidates instead
  of rejecting the episode or resumable graph migration. Other database errors
  still fail the write normally.
- **Do not send `uuid` on create.** graphiti-core 0.29.2 treats `uuid` as an
  existing episode lookup, not as a deterministic create/upsert id; sending a new
  UUID raises `node ... not found` and leaves FalkorDB empty.
- **Delete by persisted episode UUID.** Graphiti's
  `remove_episode(episode_uuid)` is the v2 lifecycle primitive. It deletes the
  episode's primary derived facts and any newly orphaned entities. The
  `{group_id, name}` raw-Cypher path exists only while pre-v2 rows lack an
  episode UUID and is removed after the graph-v2 rebuild validates provenance.
- **Singleton lifecycle.** The `Graphiti` client is built once in the FastAPI
  lifespan (driver + LLM + embedder), `build_indices_and_constraints()` on
  startup (idempotent), `close()` on shutdown. Never rebuilt per request.
- **Synchronous vs. queued ingest.** `POST /episodes` awaits `add_episode`
  (simple + testable). It returns **202** to signal the heavy/eventual nature of
  extraction; the calling API should use a generous client timeout. Adopting the
  upstream asyncio worker-queue (true async 202) is a deferred latency
  optimization, not required for the current synchronous API contract.

### Deletion-cascade verification

Run this required integration proof before changing Graphiti's pinned version or
the removal lifecycle. It creates and removes a fresh, volume-less FalkorDB
fixture; it never reads or writes the running stack's graph data.

```bash
npm run test:graphiti-cascade
```

Run this second proof before changing `/timeline`, its Cypher, or its
continuation contract. The test imports `graph.py`, so it needs the service's
real dependency set and runs inside the built image with the suite mounted; it
stubs the driver and touches no graph data.

```bash
npm run test:graphiti-timeline
```

---

## Layout

```
apps/graphiti-service/
├── Dockerfile          # two-stage; non-root; CMD binds --port 8100
├── .dockerignore
├── requirements.txt    # graphiti-core==0.29.2 + falkordb==1.6.2 + redis==8.0.1 + fastapi/uvicorn/...
├── README.md           # this file
├── config.py           # pydantic-settings: env -> Settings
├── episode_removal.py  # provenance-aware Graphiti remove_episode wrapper
├── graph.py            # driver/LLM/embedder factory + temporal Cypher reads
├── models.py           # Pydantic request/response models
└── main.py             # FastAPI app, lifespan, all endpoints
```
