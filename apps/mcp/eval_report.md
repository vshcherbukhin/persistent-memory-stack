# persistent-memory MCP — evaluation report (Phase 14, #12)

**Date:** 2026-06-29 · **Agent:** Claude Opus 4.8 (Claude Code session) · **Transport:** legacy command transport
**Server build:** `apps/mcp/dist/index.js` · **API:** `http://localhost:8090` (DEPLOYMENT_MODE=server, server-managed embeddings, `qwen3-embedding:4b`@2560)
**Fixture:** `npm run eval:seed` (teams `qa-automation` read_write + mounted `qa-manual`) · **Questions:** [`apps/mcp/evals.xml`](./evals.xml)

## How this was run (the "normal way")

Per the agreed approach, the MCP was **not** driven by a cheap robot on the personal Haiku key.
Instead it was validated the way it is actually used:

1. **Blind pass.** A general-purpose **Opus** subagent was given the 9 questions **only** (never the
   answers) and the live `mcp__persistent-memory__*` tools, and told to derive each answer from tool
   calls. It produced answers + a tool-friction report.
2. **Fix pass.** The blind pass surfaced 4 tool bugs (below). They were fixed, the server rebuilt, and
   the **entire** question set was re-run against the fixed build via a direct JSON-RPC client
   (`initialize → tools/call`), so every answer is now **tool-verified** (no derivation).
3. **Scoring.** Direct string/integer comparison against the ground-truthed `<answer>` values in
   `evals.xml` (each ground truth was itself confirmed against the live api when the fixture was built).

## Results — 9 / 9 correct (100%)

| # | What it tests | Ground truth | Agent answer | Tool chain (verified) | ✓ |
|---|---|---|---|---|---|
| 1 | Identity / readable-team count | `2` | `2` | `list_readable_teams` (own + 1 mounted) | ✓ |
| 2 | Write-protocol project fallback | `general` | `general` | `add_memory` schema / project nudge | ✓ |
| 3 | Semantic search → category | `gotcha` | `gotcha` | `search_memories` → row.category | ✓ |
| 4 | Semantic search → entity extract | `component_persistent_memory_postgres` | same | `search_memories` → row.entities[0] | ✓ |
| 5 | Exact-entity match count | `2` | `2` | `search_memories_by_entities(["permission_read_write"], all)` | ✓ |
| 6 | Cross-team (mount) read → entity | `component_manual_runbook` | same | `search_memories` (row.isOwnTeam=false) → entities[0] | ✓ |
| 7 | P9 server-side provenance | `agent_inferred` | `agent_inferred` | `search_memories` → row.sourceProvenance | ✓ |
| 8 | P9 memory tier | `semantic` | `semantic` | `search_memories` → row.memoryTier | ✓ |
| 9 | Document discovery → MIME type | `text/markdown` | `text/markdown` | `search_documents` → `get_document` → mimeType | ✓ |

The blind pass also reached 9/9 *in value*, but could only **derive** Q7/Q8 (the read tools were
returning provenance/tier as rejected-extra fields) and was **blocked** on Q9 (document discovery was
broken). After the fixes, all three are read straight from the tools.

## Bugs the eval found — and fixed (the point of the exercise)

All four are the **same class**: a tool's declared `outputSchema` drifted from the api response shape.
The MCP TypeScript SDK validates `structuredContent` with `additionalProperties:false`, so an api field
the schema doesn't declare makes the whole tool error `-32602`; conversely a field the schema *requires*
but the api doesn't send also errors. The drift was introduced by later phases (P9 provenance, P11
document lifecycle, P13 deployment mode) adding fields to api responses without updating the MCP schemas.

| Tool | Symptom | Root cause | Fix |
|---|---|---|---|
| `whoami` | `-32602 … must NOT have additional properties` (every call) | P13 added `deploymentMode` to `GET /whoami`; the tool passed the api response **wholesale** into a 7-field schema | Declared `deploymentMode`; build the structured payload **explicitly** from known fields (`apps/mcp/src/tools/identity.ts`) |
| `search_memories` | `-32602 … data/results/N must NOT have additional properties` (every call — the primary search tool) | P9 added `memoryTier/sourceProvenance/confidence/verified` to `POST /memories/search` rows; the shared `ResultRowShape` omitted them | Added the four as **optional** in `ResultRowShape` to mirror the api (`apps/mcp/src/schemas.ts`); also surfaces them so Q7/Q8 are directly answerable |
| `search_documents` | `-32602 … counts.granted: expected number, received undefined` (every call) | Schema declared `counts:{own,granted}`; the api returns `{own,other}` | Aligned the schema + summary to `{own,other}` (`apps/mcp/src/tools/documents.ts`) |
| `get_document` | Would `-32602` on undeclared extras (latent; unreachable while `search_documents` was broken) | P11 added `filename`+`versionNumber` to `GET /documents/:id`; the schema omitted both | Declared `filename` (nullable) + `versionNumber` (`apps/mcp/src/tools/documents.ts`) |

Verification: typecheck + build clean; the **whole** question set re-run over stdio against the rebuilt
server returns every answer with no schema error (incl. `whoami` deployment=server).

**Note on the live session vs the fix:** Claude Desktop spawned the MCP at session start, so the *live*
session tools remain the pre-fix build until Desktop is restarted. The fixes are verified against the
shipped `dist` via the direct stdio run, which is authoritative; a Desktop restart picks them up live.

## Why the unit tests missed this

`apps/mcp/test/` covers the api-client error mapping and the client-managed embedding bridge — **no test exercises a
tool's `structuredContent` against its declared `outputSchema`**, and the drift is between the MCP schema
and the *real* api shape (which a hand-mocked unit test would re-encode and drift from anyway). The
regression guard for this class is this eval run itself — **re-run it after any change to an api response
shape.** Two ways:
1. *(used here)* register the MCP and let an Opus Claude Code session answer the questions, or run the
   committed stdio chain against a seeded stack.
2. `npm run eval:mcp` — the vendored mcp-builder harness, for a future CI run with a real Sonnet key.

## Known tool gap (not a bug — a missing capability)

There is **no `list_investigations` / search-investigations tool**: `get_investigation` is by-id only, so
an agent cannot DISCOVER an investigation by content. An investigation-find question was therefore left out
of the eval. Graph contradiction/timeline questions are also omitted (they depend on Graphiti extraction
quality — the separately-documented local-model gap). Both are tracked in `apps/mcp/README.md` follow-ups.
