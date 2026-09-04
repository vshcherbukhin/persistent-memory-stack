# Real-Time Dashboard Development Rule

Use this rule before dashboard/UI work, Chrome-specific debugging, notification
debugging, or any task where the user will visually review local behavior.

## Mandatory Chrome Setup

- Use the Chrome/browser-control connector, not the in-app browser, Playwright,
  screenshots-only workarounds, or Computer Use, unless the user explicitly
  relaxes this rule for the current task.
- At task start, verify Chrome is connected and usable in the active user
  profile. Do not infer failure from internal profile directory names; inspect
  connector/runtime metadata and retry/refresh before concluding the profile is
  wrong.
- Verify full operation before implementation: enumerate or reuse tabs,
  navigate/click, read rendered state, capture a screenshot/DOM state, and
  confirm DevTools/CDP access for console, network, DOM/style, or service worker
  inspection when the task could need it.
- If any Chrome, extension, tab, permission, or CDP capability is missing, stop
  and guide the user through fixing Chrome connector setup, extension
  connection, active-profile installation, site approval, or Browser Developer
  mode. Do not switch to another browser-control path as a workaround.

## Dashboard Session

- Check existing Chrome tabs first. Reuse an open Persistent Memory dashboard tab
  when one exists; otherwise open `http://127.0.0.1:3200`.
- Treat the reused dashboard tab as the verification anchor. Do not open a
  parallel `localhost:3000`, `127.0.0.1:3000`, or other dev-server tab merely
  because the current dashboard bundle is stale. Use
  `bash deploy/scripts/dev-redeploy.sh redeploy-dashboard`
  or the appropriate safe redeploy path, then reload/inspect the existing `:3200` tab.
- Ask the user before creating any extra browser tab for UI verification. If an
  extra tab is opened by mistake, close it and return to the existing dashboard
  tab.
- If the dashboard requires login, ask the user to log in in Chrome and tell you
  when ready. Do not bypass the login with alternate sources or credentials.
- Keep the Chrome connection and dashboard tab available during the whole dev
  loop: inspect -> edit -> redeploy/refresh -> verify visually -> ask the user
  whether it looks right.
- Never close the dashboard tab, disconnect Chrome, or end the browser session on
  your own after a visual pass. Keep it running until the user approves the UI
  state and has no more additions.
- If the user closes the dashboard tab by mistake, reopen it and continue.

## Dev Loop Expectations

- For UI changes, verify in the live dashboard with Chrome after edits. Prefer
  direct rendered evidence over code-only confidence.
- Use the local `material-icons` package through
  `apps/dashboard/src/components/ui/Icon.tsx` for UI icons. Do not add inline SVGs,
  Unicode symbol glyphs, emoji icons, browser-default icons, or external icon
  sources for dashboard controls.
- Use reusable custom UI components for repeated controls and browser-native
  surfaces: `Tooltip`, `Checkbox`, `Select`, `Modal`, `StatusToggle`, `Input`,
  and related components under `apps/dashboard/src/components/ui/`. Do not introduce
  native browser/system controls, native `title` tooltips, raw checkbox visuals,
  or one-off local implementations when a shared component can own the behavior
  and styling.
- For notification, service worker, local storage, console, or network behavior,
  use Chrome DevTools/CDP evidence. If CDP access is unavailable, fix that setup
  with the user first.
- Keep updates short while the user reviews in Chrome, then continue iterating
  until the visual/runtime issue is genuinely handled.
