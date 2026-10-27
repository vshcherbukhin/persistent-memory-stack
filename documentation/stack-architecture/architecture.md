---
nav_title: Architecture
nav_group: stack-architecture
nav_group_title: Stack Architecture
nav_group_order: 30
nav_order: 10
---
# Architecture

Persistent Memory Community is a self-hosted personal knowledge service for AI
agents, with a local dashboard and Streamable HTTP MCP. It reuses the existing
Postgres, Qdrant, Graphiti/FalkorDB, MinIO and Redis stack.

## Authoritative knowledge and projections

Postgres retains canonical records, accepted revisions, source events, claims,
resolved entities, typed relationships and provenance. `Memory` keeps stable IDs
and explicit classification; project/system associations can name several contexts
without copying content. Existing source/claim/entity/relationship models connect
supported claims and exact concepts. Source-reported assertions, proposals and
inferences remain distinguishable from independently verified evidence.

Qdrant is a derived semantic index using the existing configured embedding model
and dimensions. Revision-specific points and authoritative relational hydration
withhold stale or deleted knowledge. Redis/BullMQ runs the existing bounded worker
pipeline. Graphiti provides derived temporal relationships; current source episodes,
record revisions and personal ownership are checked before returning graph facts.
MinIO retains uploaded evidence files. No competing knowledge engine or new
shared-core repository is introduced.

## Apps and authorization

The API is the authorization and canonical-write choke point. Dashboard and MCP
adapters use the same strict contract. Local installations retain their validated
local identity boundary; authenticated installations retain token verification and
must match that personal owner. `pm_app` remains subject to RLS. Every data query
is scoped to the current validated personal partition. Owner/control database
access is kept separate from runtime data access.

The dashboard stays behind its existing gateway (normally loopback port 3200),
with the app's port 3000 internal to its container. The existing logo/name remain,
with **Community version** directly below. Classification, relationships, accepted
revisions, provenance and processing status can be inspected and corrected without
an unrelated redesign. Existing navigation, encrypted archives and working import
state are retained.

The Streamable HTTP MCP discovers the v2 catalog, stores classified records, updates
exact revisions and performs bounded personal-space recall. Semantic/lexical
candidates and resolved-topic expansion cross the owner projects by default;
explicit filters remain strict and current-context hints only affect ranking.
Compatibility tool names are retained where sensible; obsolete write inputs receive
upgrade guidance. No unrelated transport/SDK migration is part of this release.

## Deployment and retirement

Runnable shells remain under `apps/`, capability code under `layers/`, reusable
libraries under `packages/`, and product/operator documentation under
`documentation/`. Internal `shared` package names are unrelated to the retired
Shared Memories feature. Docker-control remains the only Docker-socket holder;
updater/coordinator and gateway responsibilities remain separate from the API.

Shared connectors, mounted access, surface switching, shared-only operation and
shared-server installation are retired. Old configuration/credentials, schema and
graph namespaces can remain dormant for recovery, but cannot activate sharing or
influence personal operations. Other owners and unresolved historical records are
never combined merely because they are present in a database.

The existing public-release updater contract remains in force. The major bridge,
atomic additive migrations, isolated backup/restore reconciliation, worker fencing
and explicit recovery path are documented in the
[personal knowledge guide](../spaces/personal/knowledge-contract.md). A matching
source checkout alone is not a database rollback. Stable publication requires the
owner acceptance and merge/release authority applicable to the release.
