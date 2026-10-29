# Repository-owned development workflow

This is the shared Codex/Claude execution policy. It replaces the former mandatory
`$critical-development` overlay; it is not another installed skill or state machine.
Root and client instructions point here. Local-development, data-safety, product,
and release rules remain in force. This policy does not approve new product scope.

## Start and resume

- Read the current request, relevant repo instructions and acceptance criteria.
  Inspect branch/worktree and remote state once. Preserve newer local commits,
  dirty/untracked work, sessions and data; never reset/rebase just to satisfy a
  generic preflight. Reconcile only when integration actually requires it.
- Recall project memory when available; verify it against source and evidence.
  Missing memory, global skills, named reviewers, browser helpers or an old ledger
  are not reasons to stop independent work. Report absence once; do not repeatedly
  search for, reinstall or recreate an unavailable orchestration system.
- Optional skills may assist, but do not import additional loops or approval gates.
  Use equivalent available tools honestly. If an actual required capability is
  unavailable, identify the specific unperformed check rather than invent evidence.
- Reuse an approved plan. For a new request, keep a short scope/checklist; ask only
  about genuine missing authority or material ambiguity. Do not regenerate a plan
  merely because a session, model, branch or laptop changed.
- Keep one small optional checkpoint in `.local/documents/`: scope/authority,
  branch/source, completed evidence, next action and real blockers. No ledger
  schema, plugin, Workbench or external service is required to continue.

## Execute the approved scope

1. Implement a coherent feature slice with focused tests.
2. Integrate the completed scope and run the applicable verification once.
3. Obtain one independent read-only review of the non-trivial code candidate.
4. Batch validated material fixes, run affected checks, and request targeted
   confirmation only for unresolved findings or materially changed boundaries.
5. Update affected durable docs and hand off actual evidence and remaining limits.

Continue through these steps in the same task when possible. A package return,
checkpoint, ordinary test failure, dispatch or missing optional skill is not a
terminal result. Work to the authorized acceptance boundary; do not auto-start an
unapproved next product phase. Explicit acceptance, merge, release, external spend
and destructive-operation authority are not inferred from a green test or ledger.

## Verification budget and evidence reuse

- Use the narrowest meaningful tests while editing. For a completed runtime-code
  candidate, run the root/integration checks required by the affected components
  and the release contract. Do not run a full build/test/install matrix per file,
  commit, subagent result, review comment or status request.
- Bind results to source, dependencies/configuration, environment and command.
  Reuse valid evidence across reports and reviews. Rerun affected checks when
  their inputs change; broaden only for integration impact, changed dependencies,
  ambiguous failures, or a materially invalidated safety/release boundary.
- A docs-only final delta need not repeat unchanged runtime tests. State which
  tested source and final diff the reused evidence covers; do not claim a rerun.
- Instruction-only work needs reference/parity/content/diff checks, not unrelated
  application builds or redeployment. Changed product docs need their documented
  build/navigation checks. UI work needs real evidence for the affected flow;
  the full supported matrix belongs to release QA unless the change affects it.
- Never skip mandatory migration, ownership/isolation, backup/restore, secret,
  updater/installation or release-contract tests when that boundary changes.
  Fewer duplicate runs does not mean fewer necessary safety checks.

## Bounded independent review

- Default to one implementing task and one independent read-only reviewer for a
  non-trivial completed code scope. No mandatory reviewer brand, model or skill.
  Use a separate agent/session or the orchestrator; an implementer's self-check
  is useful but is not independent approval.
- Review the diff and existing evidence once. Findings must name a concrete defect,
  affected requirement or missing safety proof. Separate blockers from optional
  refactors, style preferences and unrelated improvement ideas.
- Use stable findings and batch fixes. Normally allow one review plus one targeted
  follow-up for the same scope, not a fresh whole-project audit after each edit.
  Further cycles require a concrete unresolved/new material issue and explanation.
- If the same issue persists after two correction attempts, stop that loop and
  return the evidence, attempted fixes and smallest decision/reproducer needed.
  Continue independent work where safe. Never waive a real defect because a cap
  was reached, manufacture approval or add reviewer-of-reviewer chains.
- If no independent reviewer is available, finish implementation and available
  checks, then hand the exact candidate to the orchestrator with review pending.
  Do not fabricate a reviewer or treat its absence as a reason not to implement.
- Parallel writers are optional: at most two, only for disjoint file scopes and
  clear benefit. No recursive delegation or competing writes. Reviewers stay
  read-only and do not rerun every proven check without an identified reason.

## UI and completion

- Existing-product work is code/runtime-first. Figma or a specific global UI skill
  is not required for ordinary fixes or reuse of established components. Honor
  explicit approved-design tasks; do not silently redesign during implementation.
- Follow `.claude/rules/realtime-dashboard-development.md` for the shared browser
  policy. Preserve current services and review tabs. Missing browser access leaves
  the specific visual check pending, not every independent implementation step.
- Report changed behavior, source/PR, checks actually run or reused, unresolved
  risks, and the next bounded action. Distinguish local, CI, runtime and owner
  acceptance. Do not claim release readiness if a required check is missing.
- Keep product/operator truth in `documentation/`, temporary evidence local, and
  client adapters aligned with this file. Never run production/release/destructive
  actions or enable paid services beyond the authority already given.
