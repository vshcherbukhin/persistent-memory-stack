# update-runner

Restricted internal sidecar for dashboard update metadata and snapshot-safe update operations.

Every release also carries `release/upgrade.json`. The compiled update-runner
release-contract library validates that metadata and plans compatibility routes
without performing any update. Run `npm run validate:release-upgrade` during
release preparation; it compiles the library with `tsc`, then verifies the
checked-out contract against the root package version.

Terminal update execution begins in the install-scoped
[`update-coordinator`](../update-coordinator/README.md). The coordinator lives
outside mutable checkouts and exact-release worktrees, serializes updates with
an atomic lock, records a durable plan, and determines the installed release
from the completed-update marker rather than a manually pulled checkout.
The 1.0.0 installer includes the coordinator; updates delegate to this runner's
`update.sh` lifecycle. Only targets on the public release line are accepted.
The runner
remains the only component that mutates the checkout and Docker stack.

- No host port is published.
- The API calls it over the Compose network with `UPDATE_RUNNER_TOKEN`.
- It snapshots `.env.persistent-memory` and data-service state into `.local/update-backups/<timestamp>/` before pulling/rebuilding.
- Dashboard status checks automatically read public GitHub `master` releases,
  without credentials or editable source settings. The single source manifest is
  `layers/update-ops/update-flow/public-source.json`. Commit metadata, `package.json`,
  and `release-history.md` are read at one immutable commit.
- Successful metadata is cached for 15 minutes; concurrent checks share one fetch.
  Failures retry after 1, 2, 4, 8, then 15 minutes, honoring longer GitHub rate-limit
  delays. The last valid metadata is retained during temporary failures.
- The current version is read from the deployed dashboard `release-history.md`
  when available, not just from the bind-mounted repo package. This keeps update
  prompts correct when the local checkout is already pulled but containers still
  need a rebuild.
- `npm run update-persistent-memory` keeps the launcher handoff at
  `.local/update-state/dashboard-handoff.json` and writes coordinator lifecycle
  state in the installer-managed coordinator directory. Before it starts Git or
  snapshot work, it verifies that the running gateway mounts both locations at
  their distinct paths, correcting a stale gateway mount when necessary. The
  gateway can therefore acknowledge the initial 5% event immediately; the
  runner still writes `.local/update-state/last-successful-update.json` after
  completion for release-note fallback. Once the coordinator publishes the
  same update id, its state is canonical; launcher writes cannot lower the
  browser percentage. The gateway also retains the highest percentage for that
  id across a short gateway restart.
- The lifecycle builds images before it deploys them: gateway image build →
  gateway start → application image build → application start with `--no-build`.
  Long-running setup and build steps publish bounded safe activity heartbeats to
  the gateway while leaving full Docker output in Terminal. Each meaningful
  heartbeat advances the browser's numeric milestone percentage within its
  declared phase; milestones are globally monotonic from launcher through
  coordinator work, and never present Docker's internal task count as a precise
  overall percentage.
- Long-running migrations may also start a short-lived, read-only progress probe.
  The first probe observes Graph V2 completed/total/remaining memory counts at
  `PM_UPDATE_PROGRESS_PROBE_SECONDS` (60 seconds by default). Probe failures are
  warnings only and never change the foreground migration or update result.
- A non-zero script exit publishes the failed lifecycle phase and a bounded,
  human-safe reason to the gateway. The failure screen replaces progress with
  that reason; Terminal remains the complete diagnostic record.
- An update refuses a checkout origin that differs from the built-in public
  repository before snapshot or lifecycle changes. Matching HTTPS and normal
  GitHub SSH origins are supported; Git transport uses the checkout normally.
- The dashboard does not run one-click updates; it shows release notes and the
  `npm run update-persistent-memory -- --branch master` command for the user to
  run in Terminal for public releases.
- Terminal updates follow the current checkout branch by default. Local
  integration testing can run `npm run update-persistent-memory -- --dev`, or
  `npm run update-persistent-memory -- --branch <branch>` for a trusted feature
  branch; branch-targeted updates require a clean checkout before switching.
- An exact released version can be deployed without changing the calling checkout:
  `npm run update-persistent-memory -- --release 1.0.0`. It resolves the version
  from `origin/master` by default (or one explicit trusted `--branch`) and creates
  or reuses `.local/release-worktrees/persistent-memory-1.0.0-<commit>`. A mismatched
  existing worktree is never reset or replaced automatically.
- Before merging incoming current-branch updates, `update.sh` auto-stashes
  generated root/dashboard lockfile drift when those lockfiles are the only tracked
  local changes. Other tracked local changes stop the update with a path list.
- Automatic update cards always follow public `master` releases. Explicit operator
  `--dev` or `--branch` execution remains available and records the deployed branch
  and commit in `.local/update-state/last-successful-update.json`.
- When metadata is temporarily unavailable, the runner keeps its last valid result;
  without an earlier successful check, no update card appears until recovery.
- It is intentionally separate from `docker-control` so the Services sidecar keeps its small list/log/start/stop verb boundary.

The runner mutates the checkout and Docker stack. Keep it internal-only and gated.
