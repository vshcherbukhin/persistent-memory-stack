# AGENTS.md - persistent-memory

Codex reads this root file automatically. The project-level Codex rules live in
`.codex/AGENTS.md`; keep this adapter short and keep both Codex and Claude rule
files aligned when the operating protocol changes.

## Required First Step

- Before non-trivial work, call `recall_context(query, project="persistent-memory")`.
  If the persistent-memory MCP is unavailable, say so and continue from repo evidence.
- The detailed persistent-memory protocol is installed by the wizard in the global
  Codex rule, `~/.codex/rules/persistent-memory.md`, unless the wizard was run with
  Project Level registration. Do not expect this repo to have
  `.codex/rules/persistent-memory.md` after a normal Global Level install.
- Then read `.codex/AGENTS.md` and the relevant files under `.codex/rules/`.
- For multi-step planning, implementation, review, resume, phase advancement, or
  status reporting, use the global `$critical-development` workflow. Its local
  ledger supplements this repository's plans and evidence; it never overrides them.
- After an approved-phase `continue`, the root Codex task runs the phase through
  implementation, verification, actual review/fix loops, documentation, and
  applicable UI evidence. A checkpoint, dispatch, package result, or pending
  technical gate is not a stopping point; stop only for a real decision/blocker
  or when the complete phase is ready for user acceptance.

## Non-Negotiables

- Existing memories, credentials, Docker volumes, and `.env.persistent-memory` are
  user data. Do not wipe or reinstall unless the user explicitly asks.
- Direct Compose commands that build/start/recreate services must include
  `--env-file .env.persistent-memory`.
- Client installs are personal-first: local Personal Memories stack first, optional
  Shared Memories connection later from the local dashboard.
- Stream MCP is the only runtime; legacy Node/stdio settings are migration aliases.
- Committed product/operator docs live in `documentation/`; development plans and
  temporary notes go only in `.local/documents/` and must not be committed.
