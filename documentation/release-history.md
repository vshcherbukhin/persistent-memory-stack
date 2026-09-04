---
nav_hidden: true
---
# Documentation Release History

## 4.0.36 - 2026-09-04

- Refreshes all six Personal Memories dashboard captures so the list, graph
  overview, focused graph, details, editor, and tools screens show the released
  three-tab navigation.
- Blurs every data-derived memory, project, tag, badge, graph, node, details,
  timestamp, count, and author value, and records that full redaction contract in
  the documentation runtime and dashboard maintainer guides.

## 4.0.35 - 2026-09-02

- Documents the Memory Graph end to end: the 3D memory space, the selection-driven flat
  2D connection map, viewpoint restore versus deliberate re-framing, right-drag movement
  with a locked rotation pivot, live activity telemetry, and the renderer and server
  bounds a reader can hit.
- Documents the user-visible **Updated** column and the `record_updated_at` field behind
  it, and records `PM_MEMORY_GRAPH_UI_ENABLED` as the released setting that exposes the
  Memory Graph tab.

## 4.0.34 - 2026-08-07

- Publishes a dedicated before/after Token Economics Report for the 4.0.34
  memory optimization release, including recall-size, exact token, retrieval
  quality, agent-answer, scope-isolation, reference-integrity, and update-routing
  evidence.
- Documents the canonical fact registry, compact references, output budgets,
  follow-up identifiers, semantic update routing, and dedicated graph version.

## 4.0.32 - 2026-07-20

- Documents the updater's self-healing Claude/Codex artifact refresh: the final
  refresh recompiles and validates the complete ignored onboarding bundle before
  execution, so partial stale `dist/` output cannot fail on a missing sibling.

## 4.0.30 - 2026-07-17

- Replaces the separate benchmark documents with one release-specific **System
  Health Report**. It makes expected behavior, full-stack lifecycle and recall
  measurements, token windows, capability evidence, cleanup, and explicit
  limitations reviewable from one documentation page.
- The report renderer is fail-closed: a required capability stays at
  **Attention required** until it has the declared evidence type. Its responsive
  report layout is checked in the real Chrome extension session before release.
- Personal-only MCP processes now advertise and route only Personal Memories.
  A stale Shared connector or environment value cannot make `shared` appear in
  the tool schema or be selected at runtime.
- MCP graph reads now fail closed with `graph_response_contract_invalid` when
  an API response lacks project/surface/relation provenance. The agent receives
  an exact retry path instead of opaque SDK validation JSON, while the MCP never
  fabricates authorization labels.
- Dashboard usage accounting labels worker/system activity as background rather
  than resolving it as a human UUID, preventing a telemetry row from taking down
  Overview. Embedding migrations tolerate concurrent point deletion and resume
  their final safe pass from the active target pin. The mutating HTTP suite now
  requires an explicit isolated-stack opt-in and uses graph-impact-aware teardown.
- The live HTTP suite now has a disposable `persistent-memory-devtest` server
  stack with independent images, containers, network, volumes, ports, secrets,
  and bootstrap identity. The suite refuses every API that does not explicitly
  report `testStack:true` in server mode before it can mutate data.

## 0.1.0 - 2026-07-13

- Establishes the first public release of the Persistent Memory documentation
  service and MkDocs manual.
- Adds Personal Space guides, source-faithful onboarding and uninstall captures,
  interactive diagrams, responsive navigation, and accessible image inspection.
- Serves the documentation through the authenticated dashboard `/docs/*` route
  while keeping generated site output out of the repository.
