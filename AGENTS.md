# AGENTS.md - persistent-memory-stack

Codex reads this root file automatically. The project-level Codex rules live in
`.codex/AGENTS.md`; keep this adapter short and keep both Codex and Claude rule
files aligned when the operating protocol changes.

## Required First Step

- Before non-trivial work, call `recall_context(query)` across the authorized personal space.
  Use `persistent-memory-stack` for memory writes about this repository.
  Project metadata organizes knowledge; it does not restrict default recall or confer ownership.
  If the persistent-memory MCP is unavailable, say so and continue from repo evidence.
- The detailed persistent-memory protocol is installed by the wizard in the global
  Codex rule, `~/.codex/rules/persistent-memory.md`, unless the wizard was run with
  Project Level registration. Do not expect this repo to have
  `.codex/rules/persistent-memory.md` after a normal Global Level install.
- Then read `.codex/AGENTS.md` and the relevant files under `.codex/rules/`.
- Read `.agents/development-workflow.md`: it is the repository-owned workflow for
  planning, implementation, review, resume, UI verification, and release handoff.
- Global skills, custom-agent names, and local workflow ledgers are optional aids,
  not prerequisites. If `$critical-development` or another workflow skill is
  absent, report it once and continue under the repository workflow. Do not stop
  to request a waiver, reinstall an old skill, or recreate its orchestration.
- Continue an approved scope through implementation, proportionate verification,
  one independent review and targeted fixes. Stop for genuine safety/scope/access
  decisions or the applicable acceptance/release boundary, not routine checkpoints.

## Non-Negotiables

- Existing memories, credentials, Docker volumes, and `.env.persistent-memory` are
  user data. Do not wipe or reinstall unless the user explicitly asks.
- Direct Compose commands that build/start/recreate services must include
  `--env-file .env.persistent-memory`.
- Community is personal-only: one local Personal Memories stack and dashboard.
  Historical shared/foreign records remain preserved outside active personal recall.
- Stream MCP is the only runtime; legacy Node/stdio settings are migration aliases.
- Committed product/operator docs live in `documentation/`; development plans and
  temporary notes go only in `.local/documents/` and must not be committed.
