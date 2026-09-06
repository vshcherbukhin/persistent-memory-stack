# Local Development Rule

- Do not reinstall the stack to pick up code changes. Use targeted redeploy helpers:
  - `bash deploy/scripts/dev-redeploy.sh redeploy-dashboard`
  - `bash deploy/scripts/dev-redeploy.sh redeploy-documentation`
  - `bash deploy/scripts/dev-redeploy.sh redeploy-api`
  - `bash deploy/scripts/dev-redeploy.sh redeploy-worker`
  - `bash deploy/scripts/dev-redeploy.sh verify`
- Work on `dev` or feature branches during normal development. Merge feature work
  into `dev`; merge `dev` to `master` only for a release bump.
- To test the integration branch through the real updater, run:
  `npm run update-persistent-memory -- --dev`.
- To test a feature branch through the updater, run:
  `npm run update-persistent-memory -- --branch <branch>`.
  Branch-targeted updates require a clean checkout before switching branches.
- To test an exact published release without changing the calling checkout, run
  `npm run update-persistent-memory -- --release <semver> [--branch <branch>]`.
  `--version` is not an updater option.
- Every first-party Node service must compile TypeScript with `tsc` and execute
  emitted JavaScript. Do not use `node --experimental-strip-types`, `tsx`, or
  `ts-node` in production images, updater paths, or host-only installer paths.
- Dashboard update cards automatically check the built-in public GitHub source
  on `master`, without user credentials or notification settings. Explicit
  terminal `--dev` and `--branch` options remain available for operator testing.
- Any direct Compose command that builds, recreates, or starts services must include
  `--env-file .env.persistent-memory`.
- Before running a redeploy helper or Compose start/rebuild, inspect the configured
  ports, `docker compose --env-file .env.persistent-memory ps`, Docker published
  ports, and active listeners. Confirm ownership before reuse.
- The dashboard gateway owns host port `3200`; the dashboard app's `3000` is
  container-internal. Do not start a parallel raw dashboard Node server for UI QA.
  The onboarding wizard may use `4319` transiently: preflight it, record the
  workflow-owned process, and clean up only that process afterward.
- If a required port belongs to another project, stop with a typed runtime conflict.
  Do not kill it, silently remap Persistent Memory, or choose an unchecked alternate.
- Prefer `COMPOSE_PARALLEL_LIMIT=1` on fresh laptops or when rebuilding images.
- Back up before risky stack changes: `bash deploy/scripts/dev-redeploy.sh backup-db`.
- Never remove volumes, regenerate secrets, or wipe `.env.persistent-memory` unless
  the user explicitly asks for data destruction.
- Local development notes, plans, and temporary specs belong in `.local/documents/`.

## Documentation lifecycle captures

- Treat onboarding and uninstall as separate capture journeys. Preserve the real
  production UI, phase order, terminal prompts, and command names; never combine
  them into a synthetic wizard or invent extra steps.
- To capture an install/update journey safely, copy the repository to a disposable
  directory under `/private/tmp`, excluding `.git`, `node_modules`, `.local`, and
  `.env.persistent-memory`. Run that copy only in a throwaway Docker container on
  an unused loopback port, with no Docker socket, home-directory mount, source
  mount, or production environment file. Confirm its mounts are empty before use.
- In a capture adapter, mock only machine-dependent probes and non-destructive demo
  outputs. The original installer/uninstaller flow and visible wording remain the
  source of truth. For terminal-only uninstall documentation, replay the prompt
  sequence from `deploy/scripts/uninstall.sh`; never run that script against a real
  stack just to obtain screenshots.
- Use only safe, generic demo data. Wait at least two seconds after each navigation
  or simulated asynchronous result before capturing. Verify every final image is a
  complete, redacted PNG in `documentation/assets/lifecycle/` and update the
  matching Markdown in `documentation/spaces/`.
- Keep the temporary capture runtime and its Chrome tab available while the user is
  reviewing screenshots. Remove the container, local image, temporary source, and
  capture tab only after the user explicitly approves teardown.
- Validate capture updates with `npm run docs:build` and
  `bash deploy/scripts/dev-redeploy.sh redeploy-documentation`, then inspect the
  rendered `/docs/` page before handoff.
