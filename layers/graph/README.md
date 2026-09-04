# Graph

## Owns
- Capability: graphiti integration, rebuild jobs, timeline data, graph query
  surfaces, and durable episode provenance contracts.
- Runtime touchpoints: API graph reads, worker rebuilds, and graph-sidecar calls.
- Dashboard touchpoints: graph views and timeline surfaces.
- Data stores: FalkorDB or Neo4j graph backends.
- Package: `@pm/graph`, consumed by the API and worker app shells.
- Source modules:
  - `src/api/graphiti-client.ts` owns the typed Graphiti HTTP client. Timeline
    reads use temporal-key/UUID continuation rather than an offset or fixed
    total-edge boundary.
  - `src/api/memory-graph-sync.ts` owns memory-row graph sync status stamping.
  - `src/api/project-group.ts` owns opaque surface/team/project Graphiti group
    derivation. Clients never submit a raw group id.
- `src/worker/graphiti-step.ts` owns worker-side Graphiti episode calls.

## Graph v2 transition

The additive Graph v2 schema persists the exact Graphiti group and episode UUID
for each graph-backed Memory/Document, plus lifecycle/outbox and migration-run
records. New lifecycle code removes episodes by UUID through
`GraphitiClient.removeEpisode`; the name-based `deleteEpisode` client method is
temporary compatibility for pre-v2 writers only.

The graph keeps temporal history. Memory score affects retrieval ordering only;
it never changes Graphiti validity fields or episode provenance. A primary badge
is computed live, and only an authorized dashboard administrator may confirm a
primary-source cascade deletion.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shell ownership owned by the planned `apps/` boundary; current
  app shell folders stay in their existing top-level locations until the app
  move phase.

## Compatibility
- `apps/api/src/clients/graphiti.ts`,
  `apps/api/src/services/memory-graph-sync.ts`, and
  `apps/worker/src/steps/graphiti.ts` remain compatibility exports for existing
  imports while the helper implementations live here.
- Runnable app shells and route modules stay in `apps/`; the Python
  `apps/graphiti-service` remains a service app, not a layer.

## Verification
- Layer checks live under `test/layers/graph/`.
