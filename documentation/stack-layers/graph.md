---
nav_title: Graph
nav_group: stack-layers
nav_group_title: Stack Layers
nav_group_order: 40
nav_order: 30
---
# Graph Layer

Source: `layers/graph/`

Owns Graphiti API client code, memory graph synchronization, and worker episode
helpers. The Graph v2 transition adds persisted group/episode provenance and a
durable lifecycle contract. The updater rebuilds Personal v2 groups from
PostgreSQL and records `graph_migration_run` state before it can remove an
unread legacy group. Graphiti write usage is correlated to the authoritative
memory/document, project, operation, and extraction stage in `graph_usage_event`.
Read and removal behavior is verified separately; this release does not claim
per-request token attribution for those operations.

The dashboard Memory Graph consumes a server-owned read model from the API. It
combines bounded PostgreSQL memory/entity metadata with Graphiti timeline facts,
falls back to memory-to-entity mention topology when Graphiti is unavailable, and
never sends raw group ids or memory content to the browser. Signed cursors bind
snapshot and activity continuation to the authenticated team/mount scope and the
active project/tag/badge filters. Graph facts advance through a temporal-key/UUID
keyset, and burst activity keeps one fixed bounded window until every page is
delivered.

## Related documentation

- [Architecture](../stack-architecture/architecture.md)
- [Graphiti service](../components/graphiti-service.md)
- [Worker component](../components/worker.md)
