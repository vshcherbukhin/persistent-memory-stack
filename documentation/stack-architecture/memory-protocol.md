---
nav_title: Memory Protocol
nav_group: stack-architecture
nav_group_title: Stack Architecture
nav_group_order: 30
nav_order: 50
---
# Agent Memory Protocol

This page documents the agent-facing memory behavior for Claude and Codex.

## Required Recall Path

For every non-trivial task, the first memory read is:

```text
recall_context(query, project)
```

`recall_context` returns the complete task-start memory picture:

- closest semantic memories,
- graph facts,
- entity expansions,
- timeline entries,
- contradictions or superseded facts,
- follow-up memory ids, entity names, and center node ids,
- a compact `contextSummary`.

`search_memories` is still useful, but only as a follow-up. It is not enough by
itself because it omits graph relations and timeline.

### Bounded recall response (schema v2)

`recall_context` returns a bounded, reference-based response so graph visibility
does not depend on repeating the same fact body in the graph, entity expansions,
timeline, contradictions, and summary. Every unique graph fact appears once in
the top-level `facts` registry. The other planes carry `factRefs`, while timeline
and contradiction entries add only their plane-specific status or relationship.

The response targets **16 KiB** and has a **24 KiB hard limit**. When full content
does not fit, it first uses explicit memory/fact previews and then omits the
lowest-priority items while preserving reference integrity. `counts.available`,
`counts.included`, and `counts.omitted` make that reduction visible to the agent;
`budget` reports the final size and whether previews or omission were needed.
Follow-up memory, entity, and center-node identifiers remain available for a
deeper tool call. A response must never contain a dangling fact reference.

### Recall recovery

Every graph fact returned through MCP must carry API-derived `project`,
`surface`, and `relation` provenance. This is both a response-contract check and
a tenant-boundary check: the MCP never fills in missing labels itself.

If a graph response is malformed, the tool returns the safe code
`graph_response_contract_invalid`, not an SDK validation dump. The agent must
retry the **same** tool once with the same query and project selection. If it
repeats, it must not claim the required recall completed or silently replace it
with a bare semantic search; it reports the Persistent Memory service fault and
continues only from independently verified current evidence. This is not solved
by changing `project`, `projects`, `scope`, or `surface`.

For ordinary `400 validation_error` responses, the MCP names the affected
request fields and asks the agent to correct only those fields before retrying.
It never echoes raw validator JSON or submitted values.

## Memory Surface Boundary

The MCP advertises only the memory surfaces that are actually connected for its
process. A Personal-only installation has a `personal` surface only: it never
offers `shared`, never tries a stale Shared connector, and routes both project
and regular-chat recall to Personal Memories. A regular non-project chat uses
the Personal `general` project.

When both surfaces are configured, the agent chooses the surface deliberately
for a project; the selected surface and named project remain mandatory recall
boundaries. Cross-team related information is additional context only, never a
replacement for the requesting team's primary project memory.

## Tool Loading Rules

Claude and Codex may defer MCP tool schemas. The installer handles this in two
ways:

- Only `recall_context` carries provider always-load metadata, keeping the
  graph-first task-start capability available without loading every PM schema.
- The generated Claude/Codex memory rule says to load persistent-memory through
  ToolSearch/tool_search when a deeper read, write, graph, document, or
  investigation tool is needed.

The MCP server also sends initialize instructions naming `recall_context` as the
mandatory task-start memory tool.

## Research Basis

- MCP tool discovery and structured outputs come from the MCP TypeScript SDK:
  [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
- Claude's deferred Tool Search and per-tool `alwaysLoad` behavior are documented in:
  [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).
- Graphiti is a temporal knowledge graph with entities, relationships, facts,
  valid/invalid time, hybrid search, and graph-aware retrieval:
  [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
  and [Graphiti search docs](https://help.getzep.com/graphiti/working-with-data/searching).
- The Graphiti LangGraph example retrieves graph facts before response and stores
  new context afterward, matching our recall-first/save-after protocol:
  [Graphiti LangGraph agent guide](https://help.getzep.com/graphiti/integrations/lang-graph-agent).
- Memory quality tests should prove answerable relationships and temporal state,
  not just API success. This follows the search/rerank/context-constructor pattern
  described in the Zep/Graphiti paper:
  [Zep paper](https://arxiv.org/pdf/2501.13956).

## Automated Verification

Run the deterministic tests:

```sh
npm test -w persistent-memory-mcp -- test/recall-context.test.ts
npm test -w persistent-memory-mcp -- test/recall-context-benchmark.test.ts
npm test --prefix apps/onboard -- test/wizard.test.ts
```

Run the package suites:

```sh
npm test -w persistent-memory-mcp
npm test --prefix apps/onboard
```

For a disposable full-stack System Health run, use the isolated harness rather
than a user stack. It creates its own credentials, containers, network, images,
and volumes; the finalization step refuses to mark cleanup complete until all of
those run-scoped resources have gone:

```sh
node scripts/release-benchmark-harness.mjs --up pm-benchmark-system-health
node scripts/run-system-health-benchmark.mjs --run pm-benchmark-system-health
node scripts/release-benchmark-harness.mjs --down pm-benchmark-system-health
node scripts/run-system-health-benchmark.mjs --run pm-benchmark-system-health --finalize-cleanup
```

The workflow writes a sanitized local evidence artifact. The report generator
validates it against its expectation manifest before it renders a published
report. It is fail-closed: a required gate that is missing, failed, or backed by
the wrong evidence type produces **Attention required**. It keeps measured
full-stack behaviour separate from deterministic contracts, integration tests,
static/build checks, manual Chrome evidence, and explicitly unmeasured
limitations.

For a local reinstall, run the opt-in live stack benchmark only when temporary
synthetic rows are acceptable:

```sh
API_URL=http://127.0.0.1:8090 PM_LIVE_MEMORY_EVAL=1 npm test -w persistent-memory-mcp -- test/recall-context-live.test.ts
```

The deterministic benchmark follows `benchmarking.md`: Alice,
Bob, Charlie, Marketing, Sales, Widget, Supplier Z, Alice Smith, and the scoped
Widgeon distractor. The live benchmark seeds a unique `demo_project_<timestamp>`
plus `other_project_<timestamp>` into the running stack, waits for graph sync,
calls `recall_context`, verifies the Widget graph/timeline/supersession picture,
and runs a 24-query retrieval matrix. Primary graph-memory deletion is intentionally
restricted, so the live test must not be used as a cleanup mechanism for a user
stack; the isolated harness is the release-safe path.
The deterministic benchmark writes its latest markdown result artifact to
`.local/benchmark-results/recall-context-benchmark-latest.md`.
The live benchmark writes its latest markdown result artifact to
`.local/benchmark-results/recall-context-live-latest.md`.

## Claude Validation Prompt

Use this in a fresh Claude Code session after reinstalling/restarting:

```text
You are validating the persistent-memory graph-first agent protocol in this repo.

Start by checking whether the persistent-memory MCP tools are directly callable.
If they are deferred, use ToolSearch to load/select recall_context before doing
anything else.

Then run:
1. npm test -w persistent-memory-mcp -- test/recall-context.test.ts
2. npm test -w persistent-memory-mcp -- test/recall-context-benchmark.test.ts
3. npm test --prefix apps/onboard -- test/wizard.test.ts
4. If a local persistent-memory stack is running and it is safe to seed temporary
   test memories:
   API_URL=http://127.0.0.1:8090 PM_LIVE_MEMORY_EVAL=1 npm test -w persistent-memory-mcp -- test/recall-context-live.test.ts

Report whether:
- recall_context was available immediately or had to be loaded via ToolSearch,
- the tests passed,
- the deterministic benchmark matched the Widget/Widgeon truth table from `documentation/stack-architecture/benchmarking.md`,
- the live benchmark returned memories plus graph facts/timeline/contradictions,
- any prompt or tool schema still nudges you toward search_memories as the first
  call.
```
