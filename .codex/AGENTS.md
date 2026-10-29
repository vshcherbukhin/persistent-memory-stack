# AGENTS.md - persistent-memory

Concise project rules for Codex agents. Keep this file under 80 lines when
possible, and never over 150 lines. Do not add rollout status, one-off gotchas,
parking notes, or historical debugging logs here.

## Start Here

- Before non-trivial work, call `recall_context(query)` across the personal space; use
  `contextHints.projects=["persistent-memory-stack"]` for relevance, and retain
  `persistent-memory-stack` as the project classification for this repository writes.
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

## Repository Development Workflow

- Read `.agents/development-workflow.md` from the repository root. It owns the
  shared Codex/Claude execution, evidence-reuse, review-budget and resume rules.
- `$critical-development`, `$ui-workflow`, named custom reviewers and their
  ledgers are optional aids. Their absence is not an implementation blocker.
  Use available tools and repository evidence; never fabricate an invocation.
- For dashboard work, also read `.claude/rules/realtime-dashboard-development.md`.
  This is a shared browser/runtime rule, not a dependency on a Claude workflow.
- Prefer the existing dashboard tab at the configured gateway (`:3200` by default).
  Redeploy the affected service safely; do not start a parallel raw `:3000` app.
- Reuse `apps/dashboard/src/components/ui/Icon.tsx` and the shared controls.
- Current product descriptions are not a veto on an explicitly owner-approved
  product change. Implement that scoped change and update its documentation;
  never weaken data-preservation or release authorization to do so.

## Product Model

- Community is a local personal knowledge space. Preserve the existing validated
  owner boundary and authentication; projects/folders never establish ownership.
- Authorized clients recall across that owner projects and general memories by
  default. Explicit project/topic/type/status/time filters remain strict; context
  hints change ranking only. Shared routing, connectors and grants are retired.
- Use the canonical v2 classified-write and expected-revision update contracts;
  discover catalog names, sources and resolution guidance through `memory_catalog`.
- Legacy-owned memories remain readable with honest unclassified metadata.
  Foreign/unresolved ownership remains preserved outside active personal recall.
- Stream MCP is the only runtime; old Node/stdio settings are migration aliases.
- Reuse functioning apps/layers/packages. `@pm/shared` is an internal library,
  unrelated to the retired Shared Memories product functionality.

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
- For product documentation changes under `documentation/`, run
  `npm run docs:build` and `npm run docs:check-navigation`.
  Keep `mkdocs.template.yml` configuration-only: never hand-edit generated `mkdocs.yml`.
- Development plans, investigation notes, temporary specs, status logs, and working
  documents must go under `.local/documents/`; they are local-only and never committed.
- Keep `documentation/`, `release-history.md`, `apps/dashboard/public/release-history.md`,
  `.claude/CLAUDE.md`, and `.codex/AGENTS.md` references current when behavior changes.
- Do not add large status sections, gotcha archives, or old-project history to this
  file. Put durable operational rules in `.codex/rules/`.

## Verification

- Follow the evidence-reuse policy in `.agents/development-workflow.md`: focused
  tests during edits; applicable integration/root checks for the completed code
  candidate, not every micro-commit. Root code checks are `npm run typecheck`
  and `npm test`; run affected dashboard/installer suites without duplicating
  suites already covered by the root run.
- Instruction-only edits require link/parity/diff checks, not unrelated builds,
  stack redeploys, browser matrices or product releases. Product-doc changes
  still require their documented documentation checks.
- Every completed phase records a documentation disposition. When product docs
  under `documentation/` change, run `npm run docs:build`; use
  `bash deploy/scripts/dev-redeploy.sh redeploy-documentation` for live review.
- Report exactly what was verified and what was not.
