# Update Ops

## Owns
- Capability: update flow, release versioning, snapshots, service control, and dev redeploy helpers.
- Runtime touchpoints: update runner, dashboard gateway, and safe redeploy scripts.
- Dashboard touchpoints: update cards, progress, and version presentation.
- Data stores: release history, snapshot metadata, and update progress state.
- Source modules:
  - `update-flow/update.ts` owns snapshot-safe update status, settings, backups,
    and command orchestration for the update runner app shell.
  - `release-versioning/release.ts` owns release-history parsing and MCP restart
    detection.
  - `release-versioning/upgrade-contract.ts` owns the strict version-1 release
    upgrade contract validator and the pure, side-effect-free upgrade-path
    planner. It accepts stable semantic versions and the restricted comparator
    ranges used by published release metadata.
  - `release/upgrade.json` is the release-owned machine-readable compatibility
    contract: minimum source version, compatible major line, direct route,
    required stops, major-version bridges, and coordinator bootstrap policy.
  - `apps/update-coordinator/` is the compiled, installer-managed update control
    plane. Its emitted artifact is installed outside mutable checkouts and owns
    the per-install lock, durable plan, one-time snapshot checkpoint, and
    release-worktree identity. It uses this layer's contract library after the
    established launcher resolves the real target, then executes all declared
    bridge hops through the update lifecycle. Interrupted paths resume from the
    last durable verified hop; malformed recovery state fails closed. Untouched
    legacy updaters install the coordinator during their existing first bridge.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shell ownership owned by the planned `apps/` boundary; current
  app shell folders stay in their existing top-level locations until the app
  move phase.

## Compatibility
- `apps/update-runner/src/update.ts` and `apps/update-runner/src/release.ts`
  remain compatibility exports for existing imports while the capability code
  lives here.

## Verification
- Layer checks live under `test/layers/update-ops/`.
- `npm run validate:release-upgrade` compiles the update-runner contract library
  with `tsc` and validates the checked-out release metadata against the root
  package version. It must pass while preparing a release.
- `npm run build:update-coordinator` compiles the coordinator with `tsc` and
  packages it with this layer's compiled contract module into
  `deploy/update-coordinator/`; the checked-in artifact must match those build
  outputs.
