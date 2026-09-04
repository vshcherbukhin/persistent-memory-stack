---
nav_title: Update Ops
nav_group: stack-layers
nav_group_title: Stack Layers
nav_group_order: 40
nav_order: 90
---
# Update Ops Layer

Source: `layers/update-ops/`

Owns update-flow and release-versioning helpers consumed by the update runner
and the installer-managed update coordinator. Snapshot and service-control
operations remain bounded by the update sidecar and Docker control sidecar.

Every release publishes `release/upgrade.json`, which declares the supported
source versions and any required bridge releases. The coordinator is compiled
with `tsc`, installed outside mutable checkouts and release worktrees, and uses
that contract to record a safe update plan before delegating to the existing
terminal lifecycle. It keeps its lock and plan state private to the installation;
the dashboard gateway has a separate, read-only mount prepared for the later
browser handoff protocol.

An untouched 4.0.24 shell can update directly to 4.0.29. The release retains
small compatibility adapters for the historical updater while it completes its
first fetch-and-build cycle; setup then installs the coordinator. Releases
4.0.0–4.0.23 need a one-time `git pull --ff-only origin master` bootstrap before
running the updater, because their updater predates the moved deployment layout.
Coordinator-capable releases resolve the actual branch or exact-release target
before planning. They read the durable
completed-update marker first, so manually pulling a newer checkout never makes
the updater mistake checkout HEAD for the running release. A legacy installation
without that marker can use the dashboard's served release history instead. The
coordinator executes declared multi-hop routes through named trusted-branch
worktrees, recording the one-time snapshot and every verified hop so a retry
resumes safely without guessing a path or rolling data back automatically.

## Related documentation

- [Operations](../stack-architecture/operations.md)
- [Dashboard Gateway](../components/dashboard-gateway.md)
- [Documentation Release History](../release-history.md)
