# AGENTS.md - persistent-memory

Concise project rules for Codex agents. Keep this file under 80 lines when
possible, and never over 150 lines. Do not add rollout status, one-off gotchas,
parking notes, or historical debugging logs here.

## Start Here

- Before non-trivial work, call `recall_context(query, project="persistent-memory")`.
  If the tool schema is deferred, load persistent-memory with `tool_search` first.
  If the MCP is unavailable, say so and continue from repo evidence.
- The full persistent-memory protocol comes from the global installed rule
  `~/.codex/rules/persistent-memory.md` for Global Level installs. This repo's
  `.codex/rules/` directory is for repo-specific development rules unless the
  installer was explicitly run with Project Level registration.
- Read `.codex/rules/local-development.md` before running, rebuilding, or touching
  Docker/local stack behavior.
- Read `.codex/rules/release-versioning.md` before changing user-visible behavior,
  install/update flow, docs, or package versions.
- Use `rg`/`rg --files` first for repo search.

## Critical Development Overlay

- `$critical-development` is the coordinator for multi-phase work and understands
  natural requests such as `continue`, `print status`, `review the code`, `fix the
  findings`, and `go to the next phase`.
- On first resume, reconcile `.local/documents/`, current source/tests, documentation,
  Git history/diff, and runtime evidence before creating the local workflow ledger.
  Never infer plan, phase, merge, or release approval from code or an old summary.
- Development plans remain local under `.local/documents/`; committed product and
  operator truth remains under `documentation/`.
- Every phase requires implementation evidence, verification, independent review,
  documentation disposition, applicable visual QA, and explicit user acceptance.
- For an approved phase, the root task directly spawns any specialists, retains
  their ids, verifies live status before saying `running`, waits for completion,
  checks their filesystem/test evidence, fixes findings, and continues through
  every technical gate in the same task. Ledger repair/writes, dispatch, worker
  return, package completion, and pending technical work are never terminal.
- Keep implementation, verification, review, fixes, documentation, and visual QA
  in `pendingWork`. Only explicit choices belong in
  `pendingHumanDecisions`; only typed external/tool/safety/scope/physical or
  destructive-authorization conditions belong in `blockers`.
- For dashboard work, the project verification anchor is the existing Persistent
  Memory Chrome tab or `http://127.0.0.1:3200`. Redeploy with
  `bash deploy/scripts/dev-redeploy.sh redeploy-dashboard`, then refresh that tab.
- Dashboard visual QA must invoke the Chrome skill and acquire
  `agent.browsers.get("extension")`, confirming `Type: extension`. Do not use
  `getForUrl`, the in-app/default/sandbox browser, standalone Playwright, or
  Computer Use as Chrome evidence, and do not open a parallel raw `:3000` tab.
- Dashboard icons come through `apps/dashboard/src/components/ui/Icon.tsx`; reuse
  the shared controls under that directory instead of browser-native substitutes.

## Product Model

- Client installs are personal-first: always install a local Personal Memories stack,
  local embeddings, local dashboard, and stream MCP first.
- Shared Memories are optional and connected later from the local dashboard with a
  server-issued connector token. The local dashboard is the single user surface for
  Personal and Shared memory management.
- Shared server dashboards are SSO/password operator consoles for super-admins only.
  Regular users and team admins use their local dashboard; their Shared permissions
  are exactly what the connector token grants.
- Stream MCP is the only runtime. Legacy Node/stdio values are migration aliases only.
- Use `server-managed embeddings` and `client-managed embeddings`; keep old
  `server` / `client-bridge` values only as wire/config aliases.
- Runnable app shells live under `apps/`; local/server deployment spaces live under
  `spaces/local-personal`, `spaces/local-shared-client`, and `spaces/shared-server`;
  capability code lives under `layers/`. Use dashboard wording for the product/app;
  reserve `admin` and `super-admin` for roles or compatibility route names.

## Safety Rules

- Existing memories, credentials, Docker volumes, and `.env.persistent-memory` are
  user data. Do not wipe, regenerate, or reinstall unless the user explicitly asks.
- Treat `master` as release-only. Normal code work lands in `dev` or a feature
  branch first; merge to `master` only with the release/version update.
- Do not run `docker compose down -v`, remove volumes, or delete data directories
  without explicit user approval.
- Direct Compose commands that build/start/recreate services must include
  `--env-file .env.persistent-memory`.
- Prefer `deploy/scripts/dev-redeploy.sh` for local code redeploys instead of reinstalling.
- Before any service start/rebuild or port assignment, inspect
  `.env.persistent-memory`, Compose service ownership/published ports, and active
  listeners. Reuse the healthy Persistent Memory stack; `:3200` is the gateway
  and container `:3000` is internal. Never kill, silently remap, or start a
  parallel Node service over another project's listener.
- Before risky stack changes, make a DB backup with
  `bash deploy/scripts/dev-redeploy.sh backup-db`.

## Documentation Hygiene

- Committed product/operator docs live under `documentation/`.
- Markdown in `documentation/` is the only documentation source of truth. Change,
  add, move, or remove Markdown first; do not hardcode a second navigation or topic
  list in an app, script, or config. `npm run docs:generate` derives `mkdocs.yml`
  from Markdown frontmatter, and the dashboard reader discovers
  `documentation/spaces/` from that same metadata.
- For documentation changes, run `npm run docs:build` and `npm run docs:check-navigation`.
  Keep `mkdocs.template.yml` configuration-only: never hand-edit generated `mkdocs.yml`.
- Development plans, investigation notes, temporary specs, status logs, and working
  documents must go under `.local/documents/`; they are local-only and never committed.
- Keep `documentation/`, `release-history.md`, `apps/dashboard/public/release-history.md`,
  `.claude/CLAUDE.md`, and `.codex/AGENTS.md` references current when behavior changes.
- Do not add large status sections, gotcha archives, or old-project history to this
  file. Put durable operational rules in `.codex/rules/`.

## Verification

- Run the narrowest meaningful tests first, then root checks for commit candidates:
  `npm run typecheck` and `npm test`.
- For dashboard-only changes, also run tests from `apps/dashboard/`; for installer changes, run
  tests from `apps/onboard/`.
- Every completed phase records a documentation disposition. When committed docs
  change, run `npm run docs:build`; use
  `bash deploy/scripts/dev-redeploy.sh redeploy-documentation` for live review.
- Report exactly what was verified and what was not.
