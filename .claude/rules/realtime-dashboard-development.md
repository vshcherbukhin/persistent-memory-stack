# Real-Time Dashboard Development Rule

Use this shared rule for Codex and Claude when dashboard/UI behavior changes.
Read `.agents/development-workflow.md` for the bounded verification/review policy.

## Proportionate browser verification

- Prefer the connected Chrome browser in the user's active profile. Discover the
  actual available browser capabilities; no particular skill name or connector
  API spelling is an implementation prerequisite.
- Inspect only the capabilities needed for the changed flow. Check DevTools/CDP
  when diagnosing console, network, notifications or service workers, not for
  every label, spacing or instruction change.
- If the preferred browser is unavailable, report that once and continue safe
  implementation and automated tests. An available browser/Playwright route may
  inspect the same deployed application with synthetic data when the task has no
  explicit browser restriction. Label the actual tool/runtime used; never call
  sandbox checks evidence from the user's Chrome or claim unperformed visuals.
- Honor explicit task-specific browser/device requirements. If those cannot be
  met, leave that acceptance check pending, continue independent work, and report
  the concrete missing capability. Do not bypass login or weaken authentication.

## Dashboard session and scope

- Inspect existing tabs and configured ports first. Reuse the matching dashboard
  tab at the gateway (`http://127.0.0.1:3200` by default). Do not start a parallel
  raw `:3000` application or capture stale/different code as current evidence.
- Refresh a current bundle after the appropriate targeted redeploy, normally
  `bash deploy/scripts/dev-redeploy.sh redeploy-dashboard`, following the local
  development rule's environment, ownership and data-preservation checks.
- Avoid duplicate review tabs. Ask before opening an extra user-facing tab when
  a matching one already exists. Preserve the handoff tab during owner review.
- Group related edits, then inspect the changed flow once. Recheck the affected
  states after a correction; do not repeat the full application/device matrix.
- For normal copy, spacing, branding-label or existing-component work, use the
  running application and established components. No mandatory Figma round trip,
  design-system promotion or full-app screenshot synchronization.
- Use an approved design source when the user supplies one. Material redesigns
  require their agreed design review; release QA covers supported themes,
  viewports and journeys. Expand focused QA when the change actually affects them.
- Request owner visual acceptance at the agreed feature/phase handoff, not after
  every edit. A known visual/functional defect still needs a fix or an explicit
  unresolved finding; passing a unit test is not visual acceptance.

## Preserve product controls

- Use `apps/dashboard/src/components/ui/Icon.tsx` and the local `material-icons`
  package. Do not introduce arbitrary SVG/emoji/external icon sources.
- Reuse shared `Tooltip`, `Checkbox`, `Select`, `Modal`, `StatusToggle`, `Input`
  and related components; do not replace their appearance/behavior with native
  controls or one-off copies. Preserve accessibility and keyboard/focus behavior.
- Use synthetic data and redact sensitive evidence. Do not change another
  project's processes, ports, credentials or browser state to obtain screenshots.
