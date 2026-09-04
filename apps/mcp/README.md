# persistent-memory-mcp

The stream MCP service that exposes Personal Memories and optional Shared
Memories to agents over Streamable HTTP. It:

1. reads Personal/Shared surface config from the local stack,
2. attaches a connector token only when routing to Shared Memories,
3. maps most MCP tools to API endpoints and composes `recall_context` across
   memory + graph endpoints, and
4. (client-managed embeddings only) embeds content/queries **locally** via `@pm/shared`'s Ollama
   bridge at the server-pinned model, and uploads the precomputed vector.

The MCP does **no** authorization or RLS itself — the **API is the single
authorization choke-point** (access model: [`documentation/stack-architecture/access-model.md`](../../documentation/stack-architecture/access-model.md)).
Identity (user / team / admin_level) is 100% server-derived from the token in
server deployments; full-local deployments are intentionally no-auth and local
only. In both cases, the MCP asserts nothing. The data plane **requires team membership** — a team-less
super-admin manages memories on the dashboard, not through the MCP. Reads are
MEMORY = own team ∪ MOUNTED teams (the dashboard manages mounts); documents/graph
are universally shared. Writes are current-team + per-author
bounded.

> **stdout is sacred.** stdout carries the JSON-RPC frames. Every diagnostic goes
> to **stderr** (`src/log.ts`); there is no `console.log` anywhere in `src/`.
> Stream request diagnostics carry only safe metadata: MCP session id, client
> name, JSON-RPC method/tool name, API method/path/status, and timing. Bodies,
> headers, and bearer tokens are never logged.

## Tool surface (25 tools)

| Group | Tools |
|---|---|
| Identity & scope | `whoami`, `list_readable_teams`, `list_projects` |
| Memory writes | `add_memory`, `update_memory`, `delete_memory`, `delete_all_memories` |
| Graph-first memory recall | `recall_context` |
| Memory reads | `search_memories`, `search_memories_by_entities`, `get_memories`, `get_memory`, `list_entities` |
| Knowledge graph | `search_graph`, `get_entity`, `get_timeline`, `get_contradictions` |
| Documents | `ingest_document` (re-upload = dedup/version-in-place), `get_ingest_status`, `search_documents`, `get_document`, `delete_document` (4-store cleanup) |
| Investigations | `create_investigation`, `link_investigation`, `get_investigation` |

- **Read/search/get** tools are `readOnlyHint`; **delete\*** are `destructiveHint`;
  every tool is `openWorldHint: true` (they all hit an external API).
- Graph/project read tools take an optional `scope` (`own` | `granted` = other
  teams | explicit team ids); reads are universal so it only NARROWS (an unknown
  team → 403 `scope_not_readable`).
- Writes never take a team — team is server-derived. Write denials surface as
  `no_team` / `not_owner` / `cross_team_denied` (the data plane is current-team only).

## Graph-first recall

`recall_context(query, project)` is the agent-facing first read for non-trivial
work. It calls the semantic memory search and graph endpoints together, then
returns one structured context containing:

- closest memories and own/other counts,
- graph facts from `/graph/search`,
- entity expansions from `/graph/entity/:name`,
- the most connected node's timeline from `/graph/timeline`,
- contradictions/superseded facts from `/graph/contradictions`,
- a compact `contextSummary` for the agent to reason over.

`search_memories` remains available for deeper semantic search, but it is no
longer the task-start entrypoint because it cannot show relation or timeline
context by itself. The MCP initialize instructions and the installer-written
Claude/Codex rules both say to use `recall_context` first. That single tool
carries provider always-load metadata; the installer intentionally does not
eagerly load the whole Persistent Memory server. All other schemas remain
deferred and the generated rules tell the agent to use `ToolSearch` /
`tool_search` when needed.

### Graph response recovery

Before returning structured graph data, the MCP verifies that every fact has the
API-derived `project`, `surface`, and `relation` labels required by its output
contract. It never fabricates those labels: doing so would weaken project and
tenant isolation. If a graph service response is malformed, the tool returns
`graph_response_contract_invalid` with a deterministic recovery path: retry the
same call once, unchanged; if it repeats, do not count mandatory recall as done
or silently fall back to semantic search. Report the service fault and continue
only from independently verified current evidence.

API `400 validation_error` messages are likewise summarized by field without
echoing raw validation JSON or submitted values. The agent corrects only the
named input and retries the same tool.

## Stream session recovery

The Streamable HTTP session registry is in-process. When `update.sh` or Compose
restarts `persistent-memory-mcp`, existing clients may briefly send their old
`Mcp-Session-Id` to the fresh process. Unknown stale ids return JSON-RPC
`Session not found` with HTTP 404 so the client can initialize a new stream
session; non-initialize requests with no session id return JSON-RPC bad request
with HTTP 400.

The Services dashboard session list is API in-memory state. If the API restarts
while the MCP service stays alive, the next MCP heartbeat receives
`registered:false` and re-sends the full session registration so the row appears
again without requiring a new agent session.

Stream sessions expire after the System Settings idle timeout (15 minutes by
default). The timeout is based on the last real `/mcp` request handled by the
stream transport, not the 10-second heartbeat used for dashboard registration.
When an expired client sends its old `Mcp-Session-Id`, the MCP closes that
transport and returns the same HTTP 404 `Session not found` response so the
agent can initialize a fresh stream session.

## The project nudge

`add_memory`, `ingest_document`, and `create_investigation` make `project` a
**required** input. If omitted, the MCP returns an actionable error *before* the
API call, nudging the agent to name its project (from cwd/git) or pass `"general"`
for a non-project/aside chat. The API defaults to `"general"`, but the MCP forces
a deliberate classification so memories stay findable.

## Self-correcting writes (422)

When the server's Shape A–E gate rejects a memory (HTTP 422), the MCP surfaces
the **full `RejectPayload`** verbatim — `reason`, `missing`, `rewrite_templates`,
`entity_format`, `valid_categories`/`valid_sources`, plus the payload in
`structuredContent` — so the agent rewrites and retries in one turn. **Never
auto-retried.**

## Server-managed vs client-managed embeddings

The MCP reads the **effective** embedding mode + pin from the API's `GET /config`
at startup — it does **not** trust its own `EMBEDDING_MODE` env (the mode is
admin-toggleable at runtime through System Settings).

- **server-managed embeddings (`server`):** send text only; the server embeds.
- **client-managed embeddings (`client-bridge`):** embed locally via `@pm/shared`'s `OllamaEmbedder`
  at the **server-pinned** model/dim (not the laptop env), and send the vector.
  A pin mismatch → 422 `embedding_pin_mismatch` → the MCP tells the agent to
  `ollama pull <activeModel>` and/or restart the session.

In client-managed mode, every completed local embedding operation is reported
best-effort to the API using a canonical outcome. The API derives its client scope
from the authenticated identity, so one client's local quota/model/network failure
cannot mark another client's embeddings unhealthy.

## Fact-extraction token exhaustion

Fact extraction runs before memory persistence. When its provider is out of
tokens/credits/quota, the MCP returns exactly:

> Fact extraction is out of tokens. The memory was not saved.

No memory write has occurred. Restore the provider quota before retrying; this is
distinct from retryable provider overload, rate-limit, or temporary-unavailable
conditions. Dashboard health records only safe canonical diagnostics, never the
provider body or credentials.

## Build & run

```sh
# from the workspace root (persistent-memory/)
npm install
npm run build -w persistent-memory-mcp        # -> apps/mcp/dist/index.js
npm run inspect -w persistent-memory-mcp      # MCP Inspector (manual smoke)
```

Deterministic graph-first benchmark from
[`documentation/stack-architecture/benchmarking.md`](../../documentation/stack-architecture/benchmarking.md):

```sh
npm test -w persistent-memory-mcp -- test/recall-context-benchmark.test.ts
```

This test uses the benchmark research document's `demo_project` truth table: Alice, Bob, Charlie,
Marketing, Sales, Widget, Supplier Z, Alice Smith, and the scoped-out Widgeon
distractor. It asserts semantic recall, graph relationships, entity expansion,
timeline invalidation, contradiction/supersession handling, and project-scope
exclusion. It writes the latest markdown result artifact to
`.local/benchmark-results/recall-context-benchmark-latest.md`.

Optional live graph-first benchmark after a local reinstall:

```sh
API_URL=http://127.0.0.1:8090 PM_LIVE_MEMORY_EVAL=1 npm test -w persistent-memory-mcp -- test/recall-context-live.test.ts
```

That test seeds a fresh `demo_project_<timestamp>` plus an `other_project_<timestamp>`
Widgeon distractor into the running stack, waits for graph sync, calls
`recall_context`, verifies the returned graph picture includes Widget/Alice/Bob/
Charlie/Marketing/Supplier context, and deletes the seeded memories unless
`PM_LIVE_MEMORY_EVAL_KEEP=1` is set. It writes the latest live-run artifact to
`.local/benchmark-results/recall-context-live-latest.md`.

Required env: `API_URL` for the local personal API. `PM_USER_TOKEN` is not used
for Personal Memories. Shared Memories use the connector token saved in the local
dashboard; legacy env-based shared tokens remain migration fallback only.
client-managed embeddings add `OLLAMA_URL` (default
`http://host.docker.internal:11434`) and optional `EMBED_*` hints (the selected
surface's server pin always wins).

Memory tools advertise only the surfaces configured for that MCP process:

- a Personal-only MCP offers only `personal` and always routes there;
- a Shared-only MCP offers only `shared`;
- both values appear only when Personal and Shared Memories are actually
  connected. In that mode, omit the field to use the configured default.

When `PM_MEMORY_INSTALL_MODE=personal-and-shared`, the MCP resolves `/config`
against both APIs and uses the selected surface's embedding mode/pin before it
adds or searches memories. This keeps client-managed shared vectors aligned with the
shared server while personal text stays local.
Personal-only mode never resolves a Shared connector, including one left in a
legacy environment variable. Blank optional surface env values such as
`PM_SHARED_API_URL=` are also treated as unset.

## Registration

See [`CLAUDE_MCP_SETUP.md`](./CLAUDE_MCP_SETUP.md) for the supported stream
registration shape.

- `PM_MCP_RUNTIME=stream` is the only generated runtime.
- The Compose `mcp-stream` profile runs one local `persistent-memory-mcp`
  Streamable HTTP service at `http://localhost:8091/mcp`.
- Claude/Codex config entries carry only that HTTP endpoint.
- Legacy command-based entries are migration aliases. Update/setup helpers rewrite
  detected persistent-memory entries to the stream URL.

The Services dashboard shows the stream service with Application services.
Active MCP connections report through the session registry and appear under MCP
sessions with connection type, last seen, and a live Terminates at countdown.
Legacy stdio clients from older installs may still appear as client-owned/loggable
rows until terminated; they are not a supported new runtime and do not use the
stream idle-timeout policy.

## MCP Evaluation

`evals.xml` defines 9 independent, read-only, verifiable Q/A pairs over a frozen
fixture loaded by `npm run eval:seed` (`scripts/eval-seed.mjs`): a primary team,
a mounted team, Shape-passing memories, and a markdown document. The questions
exercise identity/readable-teams, project fallback, semantic memory search,
entity-field extraction, exact-entity search, cross-team mounted reads,
provenance/tier fields, and document tools.

Run it either through a registered agent session or through the automated harness:

```sh
npm run eval:seed
PM_USER_TOKEN=<seed token> npm run eval:mcp
```

`test/local-mode-and-schema.test.ts` validates the drift-prone structured
outputs against their declared schemas. Re-run the eval after changing API
response shapes that are returned through MCP tools.

`whoami` includes the API's human-readable identity fields (`teamName`,
`userDisplayName`, `userEmail`) in both text and structured output. In full-local
mode this means agents can display the wizard-seeded local profile while the
stable internal UUIDs remain available for audit/debugging.

## Supporting API endpoints

- `GET /config` (public, like `/health`) → `{ embeddingMode, activeModel,
  activeDim, activeVectorName, deploymentMode }`.
- `GET /projects` (secured, `requireTeamMember`) → distinct projects across ALL
  teams (universal read) with per-project memory/document counts (own-first).
  Backs `list_projects`.

`list_readable_teams` reuses `GET /whoami` — it reports the own team (primary) +
the MOUNTED team ids (additional memory reads). Its text label uses the same
`teamName` profile field as `whoami`, while structured output stays ID-based for
callers. No new endpoint.
