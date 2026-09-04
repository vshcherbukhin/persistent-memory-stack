# update-coordinator

The update coordinator is the installer-managed control plane for terminal
updates. It is compiled with `tsc` and packaged as the dependency-free
`deploy/update-coordinator/` artifact so it can run outside the checkout and
outside exact-release worktrees.

`npm run update-persistent-memory` installs immutable artifact bundles at
`~/.persistent-memory/instances/<installation-id>/bundles/<bundle-id>/` by
default. The installation directory, bundles, state directory, and files are
private to the current user (`0700` directories and `0600` files). The stable
installation root holds the update lock and active/completed plan, while a
running update loads only its own content-addressed bundle. This anchors a
release-worktree request to the initiating checkout identity without allowing a
second launcher to replace the first controller.

For coordinator-capable releases, the coordinator resolves the requested target
through the established launcher, then reads the deployed version from the
durable update marker (or the dashboard release history only when a legacy
install has no marker). It never uses a manually pulled checkout's `package.json`
as the deployed version. It loads release contracts reachable from the selected
trusted branch, plans every declared bridge hop, and creates private detached
worktrees for intermediate releases. `hop-progress.json` records the one-time
snapshot and each verified hop. A retry resumes at the first unfinished hop;
corrupt recovery state fails closed and requires an operator to recover it.
When the resolved code revision and durable plan are already complete, the
coordinator records a no-op outcome and clears only that launcher's active
handoff, returning open dashboard tabs to the dashboard without creating a
release-completion event. Same-version branch updates are keyed by their target
Git revision, so a later trusted `dev` commit still receives a full lifecycle.
If planning or coordination fails before the lifecycle child can report its own
failure, the coordinator turns only the matching launcher handoff into a safe
failure state. It never publishes raw exception output to the browser and never
overwrites a more specific failure already reported by the lifecycle child.

The coordinator itself runs the snapshot before any lifecycle hop, then passes
the snapshot checkpoint to the legacy lifecycle so setup cannot make a duplicate
snapshot. A legacy exact target without `release/upgrade.json` (for example
`--release 4.0.27`) remains a coordinator-recorded one-hop bridge. An untouched
4.0.25–4.0.27 updater still performs its existing direct bridge to 4.0.28 first,
because an old shell cannot launch coordinator code it has not fetched.

For each lifecycle hop, the coordinator-owned handoff remains browser-advisory.
The legacy executor splits image building from container deployment: it builds
the gateway, starts that gateway, builds the remaining images, then starts those
services with `--no-build`. Optional safe activity metadata provides ordered
setup/build/deploy/verify status to a compatible gateway. The terminal retains
the complete Compose/BuildKit output; browser activity never controls or delays
the update.

Build and verify the emitted artifact with:

```bash
npm run typecheck:update-coordinator
npm run build:update-coordinator
```

`scripts/install-update-coordinator.mjs` is intentionally a thin installer for
that emitted artifact; keep planning, locking, state, and launch behavior in
`src/index.ts` rather than duplicating it in shell code.
