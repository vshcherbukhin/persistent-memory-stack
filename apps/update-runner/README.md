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
from the completed-update marker rather than a manually pulled checkout. An
untouched 4.0.25–4.0.27 updater completes its existing direct bootstrap update
first and installs the coordinator during setup; later coordinator-capable
updates delegate to this runner's existing `update.sh` lifecycle. The runner
remains the only component that mutates the checkout and Docker stack.

- No host port is published.
- The API calls it over the Compose network with `UPDATE_RUNNER_TOKEN`.
- It snapshots `.env.persistent-memory`, a redacted `update-notification-settings.json`
  summary, and data-service state into `.local/update-backups/<timestamp>/` before pulling/rebuilding.
- Dashboard status checks are read-only. With `UPDATE_CHECK_PROVIDER=bitbucket`,
  the runner uses the Bitbucket/Stash REST fields in `.env.persistent-memory` to
  read latest commit, `package.json`, and `release-history.md`.
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
- Local super-admins can edit the Bitbucket update-notification fields from the
  dashboard Notifications page. `POST /dashboard/update/test` checks the entered
  source without writing it; `GET/PATCH /dashboard/update/settings` reads or saves
  it through this sidecar. Validation failures return a safe code, message,
  remediation detail, and request id, and the sidecar writes the same request id
  to its service log. The Bitbucket token is write-only in the UI and blank means
  "keep the stored token". `/admin/*` remains a one-release compatibility alias.
- Bitbucket project repositories use `UPDATE_BITBUCKET_SCOPE=project` plus
  `UPDATE_BITBUCKET_PROJECT` for `/projects/<key>/repos/<repo>`.
- Bitbucket personal repositories use `UPDATE_BITBUCKET_SCOPE=user` plus
  `UPDATE_BITBUCKET_USER` for `/users/<slug>/repos/<repo>`.
- The dashboard does not run one-click updates; it shows release notes and the
  `npm run update-persistent-memory` command for the user to run in Terminal.
- Terminal updates follow the current checkout branch by default. Local
  integration testing can run `npm run update-persistent-memory -- --dev`, or
  `npm run update-persistent-memory -- --branch <branch>` for a trusted feature
  branch; branch-targeted updates require a clean checkout before switching.
- An exact released version can be deployed without changing the calling checkout:
  `npm run update-persistent-memory -- --release 4.0.28`. It resolves the version
  from `origin/master` by default (or one explicit trusted `--branch`) and creates
  or reuses `.local/release-worktrees/persistent-memory-4.0.28-<commit>`. A mismatched
  existing worktree is never reset or replaced automatically.
- Before merging incoming current-branch updates, `update.sh` auto-stashes
  generated root/dashboard lockfile drift when those lockfiles are the only tracked
  local changes. Other tracked local changes stop the update with a path list.
- The status payload includes the configured update branch so the dashboard can
  show the matching copy command. `master` remains semver-gated; non-`master`
  branches may show updates when the remote commit differs even if the version
  is unchanged. Successful updates record the deployed branch and commit in
  `.local/update-state/last-successful-update.json`; this marker, not the
  bind-mounted checkout HEAD, is used for dev-branch commit comparison.
- Status checks are quiet when Bitbucket/VPN/auth metadata is unavailable: the
  dashboard simply shows no update card until remote metadata can be fetched.
- It is intentionally separate from `docker-control` so the Services sidecar keeps its small list/log/start/stop verb boundary.

The runner mutates the checkout and Docker stack. Keep it internal-only and gated.
