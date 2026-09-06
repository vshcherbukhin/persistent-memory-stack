---
nav_title: Dashboard Gateway
nav_group: components
nav_group_title: Components
nav_group_order: 50
nav_order: 50
---
# dashboard-gateway

Tiny Node HTTP front door for the local dashboard URL.

## Role

`persistent-memory-dashboard-gateway` owns `http://localhost:3200` in Compose.
Its app shell lives at `apps/dashboard-gateway/`.
Normal requests are proxied to the internal Next.js dashboard container at
`persistent-memory-dashboard:3000`.

The production image compiles the gateway with `tsc` before copying only the
generated JavaScript into its runtime stage. It does not run TypeScript through
Node's type-stripping mode, so static gateway errors fail the image build before
deployment.

During `npm run update-persistent-memory`, the installer-managed coordinator
writes its canonical handoff to its private state mount. The gateway reads that
file and retains one read-only fallback to
`.local/update-state/dashboard-handoff.json` for the prior launcher protocol. It:

- serves `GET /api/update/handoff` with a stable JSON schema;
- serves a minimal update progress screen for browser navigations while the
  handoff phase is `updating`, `rebuilding-dashboard`, `verifying`, or `failed`;
- serves `GET /api/update/dashboard-ready` by probing the internal dashboard
  `/api/health` endpoint;
- keeps browser navigations on the update screen after `complete` until the
  refreshed dashboard readiness probe passes, then resumes proxying.

This keeps the public dashboard URL stable even while the dashboard container is
rebuilt or restarted.

An already-open Personal Space dashboard checks the update handoff every second,
independently of automatic release checks. The updater confirms that the gateway has received
the event, gives open tabs a short moment to switch to the blocking screen, and
then starts its snapshot and rebuild work. If no browser is open, the update
continues; the final `complete` event remains in the gateway state so the next
dashboard visit opens the release notes once.
If the coordinator confirms that the installed release and resolved Git revision
are already complete, it clears that launcher's active handoff instead. Open tabs
return to the normal dashboard; a no-op never produces a release-completion
modal.

The terminal updater refreshes this container in a short dedicated gateway-only
step after the new code is pulled, then keeps it out of the main Compose rebuild.
That lets reopened tabs use the current standalone update shell while the
dashboard, API, and runtime services are recreated behind the gateway.

The update screen intentionally stays self-contained: it renders a spinner,
progress bar, current phase, target version, timestamp, and optional error/step
details from the handoff file, then polls only the stable gateway endpoints.
It reads the launcher fallback and coordinator lifecycle handoff from distinct,
read-only mounts. The updater validates those mounts before it starts protected
work, so a gateway left over from an older lifecycle cannot delay the initial
update screen or overwrite canonical progress with a stale launcher event.
The optional protocol-v1-compatible `activity` field describes safe ordered
setup/build/deploy/verify work. Each meaningful long-running setup/build
heartbeat advances a bounded numeric percentage within its declared milestone;
the page never turns BuildKit's internal task count into a misleading overall
update percentage. Malformed or unknown activity is ignored, and older handoffs
that only contain `progress` retain their existing rendering. For one update
id, the coordinator state remains canonical after it appears, and the
self-contained shell retains its highest shown percentage across a gateway
restart; stale launcher reads therefore cannot move the bar backward. When the updater
exits with an error, the gateway replaces progress with the bounded, human-safe
failure reason while Terminal retains the complete diagnostic output.
An optional `probe` field carries a read-only observation for a long-running
phase (`message`, completed/total/remaining counts, and observation time). The
gateway validates that the counts are internally consistent, renders the safe
message separately from overall percentage, and ignores malformed observations.
The updater owns probe lifecycle: a failed probe is only a terminal warning and
never changes the foreground update command's result.
If a future coordinator protocol is not understood by the installed gateway, the
gateway serves a safe compatibility page that tells the user to follow the
terminal. That display limitation never blocks the terminal update; the durable
completion event remains available when a compatible dashboard later opens.

The proxy strips browser compression negotiation before forwarding requests to
dashboard and removes decoded compression headers from responses. Node's `fetch`
hands the gateway decoded response bytes, so forwarding stale
`content-encoding` headers can make browsers render a broken dashboard page.

## Boundaries

- No Docker socket.
- No credentials.
- No direct API access.
- No database access.
- Read-only bind mount of the repository plus a narrow read-only mount of the
  canonical runtime update-state directory. Exact-release worktrees therefore
  keep writing to the same state the already-running gateway reads.
- Dashboard readiness checks are HTTP-only through the internal dashboard health route.

## Tests

```bash
npm run test:dashboard-gateway
npm run typecheck:dashboard-gateway
```
