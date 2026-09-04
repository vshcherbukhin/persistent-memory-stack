# persistent-memory-dashboard

The **web management app** for the persistent-memory stack (Next.js 15, App
Router). The access model is documented in
[`documentation/stack-architecture/access-model.md`](../../documentation/stack-architecture/access-model.md).

It manages the local **Personal Memories** surface plus, when connected, shared
access entities (teams, users + roles, tokens, system settings — admin+) and
shared memory data. Personal memory views are team-free; Shared Memories keeps
the team/role model.

## Standalone by design (NOT a workspace member)

This app is deliberately **not** part of the root npm workspaces and has **no
`@pm/db` / `@pm/shared` dependency**. It talks to `persistent-memory-api` **only
over HTTP**, so its Docker image needs no database, no `prisma generate`, and no
native `argon2` build. Compose uses the repository root as the build context so
the image can consume pure helpers from `layers/dashboard`.

If you add dashboard functionality, keep this boundary: never import `@pm/*` here.
In Compose, browser access goes through `persistent-memory-dashboard-gateway` on
`http://localhost:3200`; the dashboard container itself listens only on internal
port 3000.

## Auth model

Server mode uses human dashboard sessions, not token-paste as the normal login:

1. Enter your dashboard email/password on `/login`, or use the recovery-token
   option when SSO/password login is unavailable.
2. Password login calls `POST /auth/login/password` and stores a signed
   dashboard session in the httpOnly cookie. Recovery login validates a PM wire
   token (`tokenId.secret`) against `GET /whoami`.
3. A plain team member lands on the Memories page and may also view
   the **Services**, **Workers**, and **Token usage** pages (org-wide, read-only); the
   remaining control-plane pages gate separately (`requireControlPlane()` → admin+).
4. All API calls run **server-side** (Server Actions / RSC / route handlers) and
   attach `Authorization: Bearer <session-or-recovery-token>` — the browser never
   calls the api directly after form submit.
5. Every dashboard navigation re-validates via `requireSession()` → `/whoami`,
   so a revoked/expired token, demotion, or password-reset-invalidated session is
   caught immediately.

Super-admins can switch System Settings → Dashboard login to SSO. The login page
then shows the SSO card and keeps recovery-token fallback for break-glass access.
When a super-admin changes the bootstrap temporary password for the first time,
the profile flow rotates and shows a recovery/MCP token once.

`src/lib/api.ts` is `import 'server-only'` so the token can never leak into a
client bundle.

The login and navigation surfaces use the product-owned `ProductMark`; repository
settings render neutral examples until a deployment supplies its own values.

**Local mode.** When the image is built with `DEPLOYMENT_MODE=local`
(the onboard full-local flow; a docker build ARG so the Edge `middleware.ts` inlines
it), the dashboard skips login entirely: `middleware.ts` returns `next()`,
`requireSession()` fetches the DB-backed local owner, and the Nav hides the
multi-tenancy pages (Teams/Users/Tokens/Mounts), team badges, super-admin badges,
and Sign-out. The api is built with the same flag and reads the DB-backed local
identity from `local_identity`, so no token is needed. If the optional local
dashboard password is set, `/login` shows **Unlock dashboard**; clearing it opens
the dashboard directly again:

```bash
bash deploy/scripts/dev-redeploy.sh clear-local-password
bash deploy/scripts/dev-redeploy.sh set-local-password 'new password'
```

`server` is the default; switching modes requires a rebuild with Compose's runtime env:
`docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory ...`.

## Pages

| Route | Who | What |
|---|---|---|
| `/login` | anyone | password sign-in, SSO card when enabled, recovery-token fallback |
| `/memories` | all members | centered **Memory List (N)** / **Memory Graph** / **Memory Tools** tabs when `PM_MEMORY_GRAPH_UI_ENABLED=true`. Memory List is the default and contains live search, project, dynamic badge, and confidence-range filters; its internal-scroll table lazy-loads more records, keeps memory text flexible, and shows compact Created plus user-visible Updated columns. Memory Graph opens as a fitted, rotatable 3D spherical corpus with camera-visible semantic zoom labels, screen-space node hit targets that stay clickable across the whole painted dot at every zoom level, a connected-node focus filter, independently searchable recent project/tag/badge filters, current/historical fact filtering, an auto-saved resizable filter rail, equal-height live-activity and node-details panes, a full-height accessible node list, renderer caps/partial states, and transient completed-operation telemetry. There is no view switch: the mode follows the selection. Selecting any node renders that node and its connections as a flat 2D map, and clearing the focus returns to 3D at the exact rotation, zoom, pan, and semantic-zoom level held before the selection. Left-drag rotates and right-drag moves the corpus through a camera view offset, so the rotation pivot stays locked on the sphere center. Automatic refitting changes only camera distance and preserves rotation; zoom-out is bounded at the full-graph fit. Completed read/create/update rows expire after a few seconds (cyan/green/amber), while touched nodes emit target waves and connected links glow with particles. **Reset view** and the filter rail's **Clear** both drop the remembered viewpoint, clear the pan, and re-frame the restored corpus without resetting the viewing angle. WebGL loss pins the flat 2D map for the rest of the session without losing graph data, filters, or selection. Memory details includes a bounded entity ego graph. Personal Memories hides team context; configured Shared requests remain server-side through the connector. Memory Tools stacks **Export memory**, **Import memory**, **Rebuild memory graph**, and **Bulk delete** cards; imports are verify-first and graph deletion remains preview-bound. Expected edit conflicts stay in the open editor with actionable toast messages. The list refreshes every 10s; graph activity polls every 2s only while its tab and document are visible, and backs off while stale. |
| `/` | admin+ | clickable dashboard overview cards for team/user counts, services health, active MCP sessions, worker liveness, 24h token usage, saved memories, plus Fact extraction and Embeddings health/model cards. Non-healthy capability cards use visible state text, safe explanation/time, and a red treatment; they deep-link to the matching System Settings section. The MCP sessions card opens Services with the MCP sessions tab selected. Members are redirected to `/memories` |
| `/services` | all members (view); control = superuser | local stack monitor — Application services shows stack/host state, terse runtime details, health badges, and live log tails with local/server time display in the details modal; Fact extraction and Embeddings are logical read-only, non-loggable rows, and host Ollama is a non-container row checked through `/api/tags` plus configured-model presence when Ollama is active. The MCP application-service row shows daemon/internal logs only. MCP sessions shows active stream connections and any legacy client-owned MCP rows separately with fixed-width connection/time columns plus shared log previews/modals; stream session logs are filtered to that session's agent communication (`/mcp` request + API calls) so they do not pollute the service row. Service names link to external UIs when a console exists; Qdrant/FalkorDB/MinIO/Neo4j login credentials are available only to admin/super-admin sessions through a masked read-only credentials modal; Graphiti links to API docs, not a graph visualization UI; stack start/stop/restart **superuser-only** (via the API → the `docker-control` sidecar, which holds the socket behind a shared-secret gate). The sidebar shows a red `!` while any service is unavailable or stopped. |
| `/workers` | all members (view); control = superuser | managed scheduled-job monitor — schedule (cron) + clear human cadence + status + last/next run + live log tails with local/server time display in the details modal (any authenticated user). The editor preserves step schedules such as `*/2` as “Every 2 minutes” rather than converting them into an incomplete minute list; run-now / pause / resume / edit-cron are **superuser-only** (GET/POST/PUT `/dashboard/workers`). The sidebar shows a red `!` for a failed enabled job or a missing worker heartbeat, but not for an intentionally paused schedule. |
| `/usage` | all members (view, org-wide) | Token usage metrics — per-service / per-model tokens, requests, req/min, est. cost, plus **By user requests** totals (display name, email, total tokens, requests); a non-healthy Fact extraction/Embeddings capability is visible even at zero usage and exposes a keyboard-focusable safe-error tooltip; window selector (Live/24h/7d/30d/90d) + Recharts token trend chart (GET `/dashboard/usage`) |
| `/security` | admin+ | DLP findings (Presidio PII + gitleaks secrets) — open list + resolve; team-admins see their team, super-admins see all (server RLS). Values are never stored, only the finding type + redacted location (GET/POST `/dashboard/security-alerts`). The sidebar shows a red `!` until the final open finding is resolved; browser push uses the existing selected Security alerts notification preference. |
| `/notifications` | admin+ | local Personal Memories enables Chrome/browser Web Push only after `/pm-sw.js` is active, then saves event-type preferences; shared/server uses per-team alert routing (email recipients + Slack webhook + min severity), and super-admins also edit the **global** row (cross-team support fan-out). SMTP relay creds live in env (PUT `/dashboard/notify-settings`[`/global`]) |
| `/documentation` | all dashboard users | native visual guide rendered from the canonical Markdown and privacy-safe screenshots under `documentation/`; opens the separate MkDocs stack manual through `/docs/index.html` in a new tab |
| `/teams` | admin+ | create / delete (super-admin); rename own team (team-admin) |
| `/users` | admin+ | create users (own team for team-admins); **`admin_level` is superuser-only** |
| `/tokens` | superuser | issue / rotate (show-once modal) / revoke MCP/API/recovery tokens |
| `/grants` (Mounts) | admin+ | directional team→team **mounts** — gate cross-team MCP **memory** reads (grantee mounts grantor) |
| `/settings` | superuser | **Fact extraction** card with model selection, masked Claude/OpenAI API-key state, a bounded 15-second backend test probe, and save-with-test; a settled failure replaces `Testing…`, while a green result clears the matching health failure. **Embeddings** has its pinned model/dim, a backend **Test embedding** probe, and a model/dim change flow that kicks off the live no-blackout re-embed switch (server-managed embeddings); **Dashboard login** password/SSO mode in server mode only |
| `/api/memories/export` | admin+ | downloads a re-importable JSON export; personal exports omit team fields, while shared exports keep team scope. The Memory Tools UI wraps this with scoped save-picker and secure `.pm` encryption support |
| `/api/health` | anyone | unauthenticated liveness probe |

The canonical Memory Graph user walkthrough and its privacy-blurred Chrome
captures live in `documentation/spaces/personal/memories.md` and
`documentation/assets/spaces/personal/`. The complete Memories screenshot set
must show the current three-tab navigation; every data-derived memory, project,
tag, badge, graph, node, details, timestamp, count, and author value is blurred.

## Version and release history

The top-header info button opens release notes for the application version from
`src/lib/version.ts`, mirrored in the root/dashboard package metadata. It loads
`/release-history.md`, served from `public/release-history.md`, in a scrollable
release-history modal. The project source of truth is the root `release-history.md`;
keep the public copy aligned because both are copied into the standalone dashboard image.
In full-local mode only, superusers also see a persistent update-available card
when the update runner detects a newer trusted release. Server/shared installs do
not poll or show update prompts from the dashboard. Separately, every local
dashboard checks the gateway handoff even when release notifications are off: an
open tab switches to the blocking update screen before rebuild work proceeds. A
completed handoff remains available to a browser opened later, which then reloads
through `/api/update/reload-ready` and opens release notes once.

Table-heavy dashboard pages use the fixed-shell layout: the sidebar and header stay
fixed, short tables keep their natural height, and the table body becomes the
scrolling region only after it reaches the available viewport height. Grid-table
headers sit outside the row scroll body so header labels never jump while rows
scroll. Services splits stack/host rows from MCP session rows so active stream
connections and legacy MCP rows do not crowd the main stack health table, with
the Services sub-view switcher rendered in the Services section above the table.
Services polls every 10 seconds for stack/MCP state, and Token usage polls the
currently selected window every 10 seconds so long-range filters update without a
page reload. The usage trend card keeps totals on the first row and renders a
full-width Recharts axes-labeled token-over-time chart beneath them; Live keeps a
moving baseline visible even before the backend has multiple trend buckets.
Settings is the exception because its vertical card stack intentionally scrolls as
a page.

Capability health is canonical and safe: `healthy`, `degraded`, `unhealthy`, or
`unknown` (not observed). Overview, Services, Settings, and Token usage consume the
same response DTO. Logical capabilities and host Ollama are intentionally not
container controls and do not expose fake logs. A later successful real operation,
or a green applicable Settings test, returns the matching scope to healthy; in
client-managed mode, the dashboard uses only the current client's observation so
one local bridge failure does not become global.

## Environment

| Var | Side | Purpose |
|---|---|---|
| `API_URL` | server (runtime) | compose-internal api URL (`http://persistent-memory-api:8090`); read by the server-side api client |
| `NEXT_PUBLIC_API_URL` | browser (build) | inlined at `next build`; host port (`http://localhost:8090`). Vestigial here — the browser never calls the api directly |
| `DOCUMENTATION_BASE_URL` | server (runtime) | compose-internal documentation service URL (`http://persistent-memory-documentation:8000`); `/docs/*` route handlers proxy it behind dashboard auth |
| `NODE_ENV` | both | `production` → secure cookie |
| `PM_MEMORY_GRAPH_UI_ENABLED` | server runtime | `true` exposes Memory Graph (the released default in `.env.persistent-memory.example`; the updater backfills the key into existing env files). Set it to `false` to hide the tab |
| `PORT` / `HOSTNAME` | runtime | `3000` / `0.0.0.0` inside the container; host access is through `persistent-memory-dashboard-gateway` on `127.0.0.1:3200` |

## Dev

```bash
cd apps/dashboard
npm install
API_URL=http://localhost:8090 npm run dev   # http://localhost:3000
npm run build                               # next build (standalone output)
npx tsc --noEmit                            # typecheck
```

The Docker image is a Next.js standalone multi-stage build containing only the
dashboard app and pure helpers from `layers/dashboard`. The separate
`persistent-memory-documentation` image builds MkDocs and the locked Mermaid
runtime. Dashboard route handlers proxy its static output at `/docs/*`, preserving
the dashboard authentication boundary without coupling documentation rebuilds to
the Next.js image. Generated docs never enter git.

The image also includes `documentation/spaces/` and
`documentation/assets/spaces/` for the native documentation reader. Both
the native reader and MkDocs consume this canonical source. Guide screenshots
are authenticated PNG assets with private, no-cache responses; follow the
redaction policy in `apps/documentation/README.md` before adding or replacing
one.
