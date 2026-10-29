---
nav_title: Access Model
nav_group: stack-architecture
nav_group_title: Stack Architecture
nav_group_order: 30
nav_order: 40
---
# Access model

Community authorizes one validated local personal owner. The API derives that
identity from the existing local identity mapping or, on an authenticated
installation, a verified credential that matches that exact mapping. Authentication,
loopback defaults and the optional dashboard lock remain intact; this change never
turns a networked authenticated service into an unauthenticated remote service.

Projects, systems, topics, aliases, folders and sessions are organizational metadata.
They cannot establish ownership or grant access. Omitted project filters search the
personal space; explicit project/topic/type/status/time filters remain strict.
Current-context hints affect ranking only.

`pm_app` remains NOSUPERUSER/NOBYPASSRLS. Every data operation uses `runInTenant`.
Broad read and mounted-team flags remain disabled. Restrictive policies require
both the current partition and the validated local personal partition; memory reads
also require positively established personal ownership and exclude deleted rows.
Worker maintenance obtains that same partition from the server-owned identity map.
Global-role compatibility fields and dormant TeamGrant rows confer no cross-owner
read path. Control tables remain owner-client-only.

Historical data is preserved, including original ownership evidence. The migration
activates only exact existing local-owner/author matches. Foreign, cached and
unresolved ownership stays outside active personal recall. Imported foreign/unknown
records are retained separately in append-only quarantine. A project/folder name
or selected archive is never proof of ownership.

Canonical v2 writes reject caller-supplied identity, revisions and processing state.
Updates use exact expected revisions and preserve accepted snapshots. All content
and metadata/evidence pass the existing fail-closed content gate. Derived indexes
are never authorization truth: retrieval hydrates current canonical rows under RLS,
and graph evidence needs current authorized source episodes.

Own profile/password and owner credential administration remain available. New
sharing-account/partition administration, grants and remote connectors are retired.
Existing foreign users, credentials, partitions and migration history remain stored.

See the [knowledge contract and migration guide](../spaces/personal/knowledge-contract.md)
for schemas, provenance, legacy conversion and recovery. Historical release notes
may describe retired sharing behavior; they do not authorize current access.
