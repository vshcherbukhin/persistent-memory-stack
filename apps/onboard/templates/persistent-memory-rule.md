# Persistent Memory protocol

Team-shared, cross-session memory via the `persistent-memory` MCP. Use it the
way a strong human teammate uses experience: begin with what is already known,
verify it against current evidence, then add what future sessions should not have
to rediscover.

The server owns auth, team scope, embedding model/dim, and Shape validation.
Trust tool errors and self-correct; never resend a rejected payload unchanged.

## Default behavior

- Before non-trivial work, retrieve memory first. Do this before planning,
  editing, reviewing, debugging, or answering architecture/process questions.
- If the task is tiny and self-contained, you may skip retrieval. Examples:
  spelling, formatting, simple arithmetic, or a one-line command with no project
  context.
- If memories are missing, sparse, or clearly stale, say so briefly and continue
  from repo/docs/tests/runtime evidence. Then save the durable lesson once it is
  learned.
- Use memory as prior context, not as proof. Current source, tests, runtime, and
  direct user correction beat old memory.

## Choose Personal Or Shared Memories

- At the start of a new project, if both surfaces are configured, ask which memory
  surface to use and present the user with two choices: **Personal Memories** or
  **Shared Memories**. Use the client/app interactive panel when one is available;
  otherwise ask plainly in chat before saving project memories.
- If only one memory surface is configured, use that surface without inventing the
  missing option.
- Persist the project memory surface choice under the project-level agent config
  when possible (`.claude/` for Claude, `.codex/` for Codex). Future sessions in
  that project should automatically read and write the selected surface.
- If a project has a parked memory-surface choice, use it for all memory reads and
  writes unless the user overrides it. When a tool accepts a `surface` argument,
  pass the parked surface explicitly.
- Non-project conversations and scratch sessions always use personal memory with
  `project: "general"`.
- When the surface is ambiguous and the user is unavailable, prefer Personal
  Memories for private/non-project work and Shared Memories only for clearly
  team-owned repository or company work.
- In the persistent-memory repo, preserve the repository ownership vocabulary:
  runnable processes under `apps/`, deployment spaces under `spaces/local-personal`,
  `spaces/local-shared-client`, and `spaces/shared-server`, capability code under
  `layers/`, reusable packages under `packages/`, and committed docs under
  `documentation/`. Use `dashboard` for the web product/app; use `admin` and
  `super-admin` only for roles, permissions, or compatibility route names.

## Retrieve the picture

A single semantic hit is a lead, not the full answer. For meaningful work, the
first source is the graph-first recall context.

1. Make the persistent-memory tools callable. If `recall_context` is not visible
   because tools are deferred, use `ToolSearch select:recall_context` in Claude or
   `tool_search` for `persistent-memory recall_context` in Codex before acting.
2. Run `recall_context(query, project)` with the repo/project name. It returns the
   closest memories plus graph facts, entity expansions, timeline entries, and
   contradictions. Treat this as the task-start memory picture.
3. Use low-level tools only to deepen the picture: `search_memories` for extra
   semantic hits, `search_memories_by_entities` or `list_entities` for exact
   entity recall, and graph/timeline tools for additional relationship or history
   inspection.
4. Re-query with the better vocabulary you discovered. Stop when memories,
   graph/timeline, current source, tests, and runtime evidence agree enough to act.

Own-team memories are the primary source. Mounted-team memories are useful
context, but verify before applying them.

## Work through unknowns

- Before substantial or ambiguous work, do a brief blind-spot pass: identify the
  decisions or missing facts that could change architecture, data model, UX,
  security, operations, or migration behavior.
- Ask only high-leverage questions whose answers would materially change the
  implementation. If the answer would not change the work, state the assumption
  and continue.
- Prefer concrete references from the repo, runtime, screenshots, docs, tests, or
  known-good source code over abstract best-practice guesses.
- During longer work, keep temporary implementation notes under `.local/documents/`
  when important deviations, assumptions, or edge cases appear. Do not commit
  those notes unless the user asks.
- At completion, report the resolved unknowns, remaining risk, and what was
  actually verified. Save durable lessons with memory tools.

## Scope every write

- `project` is required. Use the real repo/product name (for example
  `persistent-memory`) or `general` only when there is no project context.
- `entities` must be lowercase snake_case with a type prefix, for example
  `component_memory_rule`, `protocol_safe_redeploy`, or `tool_add_memory`.
- Every entity in metadata must appear verbatim in the memory content.
- One memory should capture one durable fact, correction, gotcha, decision, or
  workflow rule. Do not bundle unrelated notes.

## Save immediately when it matters

Call `add_memory` in the same response when any trigger fires:

- The user corrects you or says a previous assumption was wrong.
- A hint unblocks the task.
- You discover or fix a non-obvious error.
- A tool behaves differently than expected and there is a workaround.
- You learn a durable project convention, migration path, operational gotcha,
  user preference, or product decision.

Good memory content explains: what happened, why it matters, and the correct
future behavior. Write for a teammate or a future session, not for a transcript.

## Update or delete stale knowledge

- Use `update_memory` when an existing memory is still basically right but needs
  a sharper wording, newer constraint, or additional detail.
- Use `delete_memory` when a memory is false or harmful. Then add the corrected
  memory if the lesson is still durable.
- User corrections are premium signal. Save the correction and reconcile anything
  it contradicts.
- Do not create near-duplicates when editing an existing memory would preserve a
  cleaner corpus.

## Tool discipline

- `recall_context` is the normal first memory read. `search_memories` alone is
  not enough for non-trivial work because it omits graph relations and timeline.
- Read tool schemas before first use in a session. The schema is the contract.
- A 422 validation response usually includes rewrite guidance. Change the shape,
  category, content, or entities accordingly; do not retry the same payload.
- If auth, transport, or indexing looks broken, tell the user. Do not pretend the
  memory was saved.
- For high-risk work, cite the memories or summarize the memory-derived context
  before acting so stale assumptions are visible.

Task start: retrieve. Task end: ask "what should the next related session already
know?" and save that.
