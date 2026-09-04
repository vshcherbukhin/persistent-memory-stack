# Release History

## 4.0.37 - 2026-09-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.37 | Publishes the Anthropic SDK 1.x compatibility release metadata. |
| api | 0.5.10 | Unchanged from 4.0.36. |
| graphiti service | 0.1.3 | Keeps Graphiti 0.29.2 extraction compatible with Anthropic SDK 1.x. |
| graph | 0.1.2 | Unchanged from 4.0.36. |
| mcp-runtime | 0.1.3 | Unchanged from 4.0.36. |
| database | 0.3.2 | Unchanged from 4.0.36. |
| docs | 0.2.9 | Documents the Anthropic message-boundary compatibility behavior. |

- Normalizes Graphiti 0.29.2 Anthropic calls before they reach
  `messages.create()`, removing the legacy `temperature`, `top_p`, and `top_k`
  keywords that Anthropic SDK 1.x rejects with `TypeError`.
- Pins the tested Anthropic SDK 1.3.0 dependency and extends the fail-closed
  Graphiti contract tests so a future clean image cannot silently lose this
  compatibility boundary.
- Preserves every supported request field and the existing best-effort usage
  telemetry behavior; current-model sampling semantics remain unchanged.

## 4.0.36 - 2026-09-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.36 | Publishes the synchronized documentation-update release metadata. |
| api | 0.5.10 | Unchanged from 4.0.35. |
| graphiti service | 0.1.2 | Unchanged from 4.0.35. |
| graph | 0.1.2 | Unchanged from 4.0.35. |
| mcp-runtime | 0.1.3 | Unchanged from 4.0.35. |
| database | 0.3.2 | Unchanged from 4.0.35. |
| docs | 0.2.8 | Refreshes the complete Memories screenshot set for the three-tab release with private values blurred. |

- Refreshes all six Chrome captures in the Personal Memories guide so the list,
  graph overview, focused graph, details, editor, and tools screens show the
  released three-tab navigation.
- Blurs every data-derived value in those captures, including projects, tags,
  badges, counts, node labels, accessible rows, memory fields, timestamps,
  metadata, and authors.
- Synchronizes the public walkthrough, dashboard maintainer notes, documentation
  capture conventions, version manifests, and upgrade metadata. Runtime behavior is
  unchanged from 4.0.35.

## 4.0.35 - 2026-09-02

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.35 | Publishes the Memory Graph release: a live 3D memory space that flattens to a focused 2D map. |
| api | 0.5.10 | Adds the bounded, metadata-only Memory Graph read model and the user-visible record update time. |
| graphiti service | 0.1.2 | Streams the chronological fact timeline through a deterministic keyset continuation. |
| graph | 0.1.2 | Carries timeline keyset state and fact creation time through the Graphiti client. |
| mcp-runtime | 0.1.3 | Returns the user-visible record update time on recall result rows. |
| database | 0.3.2 | Adds the `record_updated_at` column with its backfill and the project-scoped graph read indexes. |
| docs | 0.2.7 | Documents the Memory Graph, its interaction model, and the setting that exposes it. |

- **Memory Graph** is now a third tab on Memories, enabled by default. It renders the
  same authorized corpus you can already list: memories form the shell of a rotatable
  3D sphere and their entities sit inside it, the fitted overview hides labels, and
  semantic zoom reveals labels for the nodes actually facing the camera.
- The view has no mode switch. Selecting a node isolates that node with its directly
  connected memories and entities as a flat 2D map, which is easier to read than a
  rotating one; **Clear focus** and the **Details** close button return to 3D at the
  exact rotation, zoom, pan, and label level held before the selection. **Reset view**
  and the filter rail's **Clear** deliberately re-frame the corpus instead, because
  clearing filters restores memories the previous framing never covered.
- Left-drag rotates and right-drag moves the corpus through a camera view offset, so
  the rotation pivot stays locked on the center of the sphere however far you pan.
  A node stays clickable across its whole painted circle at every zoom level.
- Live activity is visualization telemetry, not an audit log: completed read, create,
  and update operations appear for a few seconds (cyan, green, amber) while the touched
  nodes emit target waves and their connected links glow and carry particles.
- The graph read model is bounded and metadata-only. `/graph/snapshot`, `/graph/facets`,
  and `/graph/activity` page through temporal-key continuation, facet searches target one
  section at a time, and renderer caps plus partial-state messages explain any server or
  browser boundary rather than silently truncating. A WebGL failure keeps the flat 2D map
  for the rest of the session with the same data, filters, and selection.
- The Memory List now shows Created alongside a user-visible **Updated** column. A new
  `record_updated_at` column advances only when the memory record itself changes;
  embedding, graph sync, access reinforcement, and safety bookkeeping no longer make a
  memory look freshly edited. Existing rows inherit their best historical approximation
  during the migration.
- The Graphiti `/timeline` endpoint is now keyset-paginated on its temporal key plus UUID
  and reports `next_after_at` / `next_after_uuid`, so a long fact history streams
  completely and deterministically instead of stopping at a fixed limit.
- `PM_MEMORY_GRAPH_UI_ENABLED` controls the tab. The released example sets it to `true`,
  and the updater backfills the key into an existing `.env.persistent-memory`; set it to
  `false` to hide the tab.

## 4.0.34 - 2026-08-07

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.34 | Publishes the measured memory token-economics release. |
| api | 0.5.9 | Routes no-op, metadata-only, content, and project-move updates to only the required downstream work. |
| worker | 0.1.4 | Rebuilds and backfills graph provenance with a dedicated graph content version. |
| mcp | 0.4.8 | Returns compact graph-first recall contexts with canonical fact references and bounded output. |
| mcp-runtime | 0.1.2 | Packs memories, graph facts, entities, timelines, and contradictions without repeated fact payloads. |
| graph | 0.1.1 | Stamps graph episodes with the dedicated graph version rather than recall metadata churn. |
| database | 0.3.1 | Adds the durable memory graph-version field and migration. |
| update / test | 0.6.2 | Adds reproducible token, retrieval-quality, agent-answer, isolation, and update-routing comparison gates. |
| docs | 0.2.6 | Publishes the 4.0.34 before/after benchmark report and the optimized protocol. |

- `recall_context` now emits one canonical fact registry and lightweight references from graph, entity, timeline, and contradiction views. A 16 KiB soft target and 24 KiB hard cap preserve the graph-first memory picture while bounding agent context; previews, omission counts, and follow-up identifiers retain visibility into compacted results.
- The isolated 4.0.33-to-4.0.34 benchmark reduced total recall bytes by 74.5%, estimated recall tokens by 74.0%, duplicate-fact bytes by 100%, and six agent-sample input tokens by 74.6%.
- Memory quality stayed within the release gate: expected-memory hits remained 24/24, agent answers remained 6/6, project leaks and dangling fact references remained zero, and mean reciprocal rank moved from 0.8323 to 0.8115 while staying above the 0.80 floor and within the allowed 0.03 delta.
- Exact no-op, session-only, same-project, and identical-metadata updates now use zero model tokens. Metadata-only updates retain fact validation but skip embeddings and Graphiti, while real content changes retain embedding and graph work.
- Memory graph provenance now advances through a dedicated `graphVersion`; project moves keep Postgres, Qdrant, and Graphiti aligned without letting access/recall metadata churn create new graph episodes.
- The full measured comparison, methodology, thresholds, and limitations are published in the stack documentation's **4.0.34 Token Economics Report**.

## 4.0.33 - 2026-08-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.33 | Publishes the context-efficiency and reproducible Graphiti build release. |
| MCP / onboard | 0.6.3 | Defers all non-essential Persistent Memory schemas while retaining graph-first recall. |
| graphiti service | 0.1.1 | Pins the known-compatible FalkorDB and redis-py client pair for clean image builds. |

- Claude registrations no longer set server-wide `alwaysLoad:true`. Only the read-only `recall_context` tool is eager, so an agent can start a meaningful task with the graph-first memory picture while write, document, graph, and admin tools load only when needed.
- The installer, MCP manifest, and documentation now prove that no non-recall tool receives eager-load metadata.
- The Graphiti service now pins `falkordb==1.6.2` and `redis==8.0.1` alongside Graphiti 0.29.2. A clean build cannot float to redis-py 8.1.0, whose async pool argument breaks FalkorDB's synchronous cluster probe during Graphiti startup.
- A lightweight dependency-contract test protects those exact Graphiti/FalkorDB/Redis versions as part of the standard repository test command.

## 4.0.32 - 2026-07-20

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.32 | Publishes the updater recovery release. |
| update / onboard | 0.6.2 | Rebuilds and validates the compiled Claude/Codex refresh helper at the point of use. |

- The final update step no longer trusts a Git-ignored onboarding `dist/` directory left by an older or interrupted installation. It recompiles the helper immediately before use and verifies the entry point, imported registration/rule modules, and generated rule template before refreshing agent artifacts.
- A partial old `dist/` folder with `agent-update.js` but no `register.js` now repairs automatically instead of failing after the main runtime update has completed.
- Onboarding tests now exercise this stale-artifact recovery path and correctly validate configurable project image prefixes.

## 4.0.31 - 2026-07-19

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.31 | Adds persistent, scoped sidebar attention signals for Security, Services, and Workers. |
| graph / worker | 0.1.0 | Hardens Graphiti search input handling and timeouts while preserving project-scoped graph operations. |
| update / test | 0.6.1 | Isolates release benchmark and integration topology from the live personal stack. |

- The sidebar now shows one accessible red `!` only for unresolved Security findings, unavailable/stopped Services, or failed enabled Workers/missing worker heartbeat. A successful final Security resolution clears its marker without waiting for a runtime-status response; deliberately paused workers remain quiet.
- Personal browser notifications remain a single path: a newly recorded Security finding uses the existing selected **Security alerts** Chrome/browser notification preference, with no duplicate alert delivery.
- Graphiti full-text safety now sanitizes backend search operations, bounds its query timeout, and retries migration input through the corrected revision path so malformed graph input cannot stall an upgrade.
- Release benchmarks and live HTTP integration now use separately namespaced topology, credentials, ports, volumes, and cleanup checks so validation cannot create records in a user’s live stack.
- MCP surface routing now keeps Personal-only installs Personal-only and returns actionable recovery guidance when a graph response violates its required provenance contract.

## 4.0.30 - 2026-07-16

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.30 | Completes the project-scoped graph safety and Memory List release. |
| graph / worker | 0.1.0 | Rebuilds Personal graph partitions from Postgres during update, records durable provenance, validates before legacy cleanup, and emits correlated Graphiti usage events. |
| update/ops | 0.6.1 | Runs the resumable Graph V2 migration after the protected snapshot and schema/RLS update, before final verification. |

- Graph reads and writes are project-scoped; a regular chat remains Personal `general`, while cross-project recall requires an explicit project list.
- The updater rebuilds and validates v2 graph partitions from authoritative Postgres Memory data. A failed or interrupted run resumes from `graph_migration_run` and never removes legacy groups before validation passes.
- Graphiti usage events now retain the operation, record, project, stage, model, tokens, latency, and outcome needed to measure partition cost without disabling graph history.
- The Memory List now supports lazy loading, badge/score filters, graph-primary impact safeguards, and immediate confidence-range filtering. Automatic archive and manual verification workflows are retired.
- Graphiti write telemetry now maps its API-trusted camel-case context to the internal snake-case usage contract, so accepted graph writes produce correlated usage rows instead of silent HTTP 400 drops.
- Recall reinforcement no longer changes the graph content version. An accepted episode that cannot stamp its captured version is queued for exact lifecycle removal, preventing unprovenanced graph facts.
- The update progress probe uses the current opaque Graph V2 partition contract, persists its selected release version through the update session, and reports safely without changing migration behavior.
- The Workers schedule editor now renders compact cadence summaries and preserves its minute selection correctly; benchmark reports are available in the documentation as a final navigation group.
- The final documentation now publishes one fail-closed System Health Report for
  this release, with isolated recall/lifecycle/token measurements, exact
  contract evidence, cleanup proof, and explicit deferred validation. A
  Personal-only MCP now exposes only Personal Memories, even if a stale Shared
  connector or default remains in its environment.
- MCP graph reads now validate API-derived project/surface/relation provenance
  before SDK output validation. A malformed response returns the actionable
  `graph_response_contract_invalid` recovery path instead of opaque validation
  JSON; the MCP never fabricates labels across project or team boundaries.
- Dashboard usage aggregation now treats worker/system actors as background
  activity instead of querying them as UUID users, so background telemetry cannot
  crash the Overview page.
- A live embedding migration now tolerates points deleted during reconciliation
  and can resume its final safe pass on the already-active target pin. Mutating
  HTTP integration tests require an explicit isolated-stack opt-in and clean up
  through the dashboard graph-impact workflow.
- Live HTTP integration now starts only through a separately namespaced
  `persistent-memory-devtest` server stack. It uses distinct containers, images,
  ports, network, volumes, secrets, and bootstrap token; the runner verifies the
  API's immutable `testStack:true` marker before making any mutation.

## 4.0.29 - 2026-07-14

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.29 | Publishes the compatibility release and its upgraded release notes. |
| update/ops | 0.6.0 | Supports direct terminal updates from every 4.0.24 installation while retaining the canonical deployment layout. |
| update-coordinator | 0.1.0 | Accepts 4.0.24 as the earliest supported direct source for the 4.0.29 contract. |
| documentation | 0.1.0 | Documents the automatic-update boundary and one-time bootstrap for older installations. |

- `npm run update-persistent-memory` now supports direct updates from 4.0.24 onward.
- The release keeps only thin compatibility adapters for the historical 4.0.24 updater: its root Compose entry point, Prisma path, and RLS command delegate to the canonical deployment files.
- 4.0.0–4.0.23 installations require one manual `git pull --ff-only origin master` bootstrap before using the normal updater.

## 4.0.28 - 2026-07-13

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.28 | Adds a non-persisting Bitbucket connection test, clear inline application-update results, and a notification-independent update safety handoff. |
| api | 0.5.8 | Proxies safe updater validation failures without reducing them to a generic 500. |
| update-runner | 0.3.5 | Validates proposed update sources without writing settings, starts reliably under Node 22, and logs failures as errors with a request id. |
| update-coordinator | 0.1.0 | Installs a compiled, private update controller that executes declared multi-hop plans with durable snapshot and hop recovery. |
| dashboard-gateway | 0.1.8 | Keeps canonical update events across worktrees, browser restarts, and one-release protocol compatibility. |
| documentation | 0.1.0 | Aligns the Markdown source tree, dashboard documentation navigation, and release display. |

- Application updates can now test the currently entered Bitbucket URL, token, repository, and branch before saving any setting.
- Failed connection checks identify the cause and next action while keeping tokens redacted; the updater service log records the same failure with a request id.
- The dashboard documentation now follows the Markdown source structure, including grouped installation, spaces, stack layers, stack architecture, and components guides.
- Security: upgraded Nodemailer to 9.0.3 and the onboarding static-file server to 10.1.0, removing the current high-severity mail and installer path-handling advisories.
- Application updates settings now control release notifications only. Every open local dashboard observes the gateway update handoff before snapshot/rebuild work continues, while a browser opened after completion receives the queued release-notes modal.
- Exact-release worktrees now retain the same gateway handoff state as the live stack, so the stable dashboard URL never loses the update event.
- The updater signals the gateway first and gives open tabs time to switch to the update screen before it begins the local snapshot.
- The updater can target an exact release with `--release <semver>` without changing the calling checkout. It uses a version-and-commit-named release worktree, preserves the existing runtime configuration and data, and records the selected source branch and commit.
- Snapshotting now supplies its explicit Compose file, so versioned updates retain both the PostgreSQL logical dump and the volume archive before rebuilding.
- First-party services and workers now emit explicit warning and error severity markers; the dashboard recognizes Node errors that include bracketed error codes, so failures no longer appear as informational log lines.
- Terminal updates now install an external coordinator that locks each installation, resolves the actual branch or exact-release target before validating published upgrade contracts, executes declared bridge hops from durable checkpoints, and reads the deployed-release marker instead of a manually pulled checkout. Unknown gateway protocols show an advisory terminal-following page without blocking the update. Untouched 4.0.25–4.0.27 shells retain their existing first bridge and install the coordinator during setup.

## 4.0.27 - 2026-07-13

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.27 | Waits for an active service worker before creating a browser Push subscription. |
| docs | 0.2.5 | Documents reliable first-use Chrome/browser notification activation. |

- Fresh Chrome/browser notification enablement now waits for the newly registered `/pm-sw.js` worker to become active before calling `PushManager.subscribe`, preventing the `Subscription failed - no active Service Worker` failure.

## 4.0.26 - 2026-07-13

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.26 | Shows fact-extraction and embedding capability health, including actionable error states and usage-table indicators. |
| api | 0.5.8 | Records model-dependency health, surfaces provider failures, and returns an explicit MCP error when memory saving cannot complete. |
| worker | 0.1.3 | Records embedding success and failure observations during memory processing. |
| mcp | 0.4.7 | Preserves actionable fact-extraction and embedding failure details for MCP clients. |
| mcp-runtime | 0.1.1 | Propagates structured memory-save failure details to the MCP boundary. |
| update/ops | 0.5.9 | Safely redeploys an isolated dashboard source through the live gateway handoff without recreating the gateway. |
| docs | 0.2.4 | Documents model-dependency monitoring and the safe dashboard redeploy flow. |

- Fact extraction and embeddings now report their current model, last successful request or test, and clear unhealthy states across the dashboard, Services, System Settings, and Token usage.
- An exhausted or unavailable model now stops memory saving with an explicit MCP response instead of leaving the caller without the reason.
- The System Settings tests restore capability health after a successful run, while real successful requests also heal the corresponding capability automatically.
- `redeploy-dashboard` now supports isolated worktrees, stores backups in the live runtime, and keeps the localhost gateway online while replacing only the dashboard service.

## 4.0.25 - 2026-07-09

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.25 | Uses canonical `/dashboard/*` API calls and dashboard naming, and adds a native screenshot-backed guide at `/documentation`. |
| api | 0.5.7 | Registers `/dashboard/*` as the canonical control route family while keeping `/admin/*` as a one-release compatibility alias. |
| mcp | 0.4.6 | Reads saved Shared Memories connection state from the canonical dashboard route. |
| onboard | 0.7.1 | Saves Shared Memories connection settings through the canonical dashboard route. |
| dashboard-gateway | 0.1.8 | Uses dashboard-named upstream configuration while keeping the existing Compose service target compatible. |
| documentation | 0.1.0 | Establishes the first public MkDocs documentation service behind authenticated `/docs/*`, with guides, captures, navigation, and interactive diagrams. |

- `/dashboard/*` is now the canonical dashboard control and memory-management API family.
- `/admin/*` remains registered as a compatibility alias for one release and reuses the same handlers.
- Dashboard, MCP, onboarding, tests, and committed docs now call or describe the canonical dashboard routes.
- `/documentation` renders the native Personal Space visual guide from canonical Markdown and privacy-safe screenshots.
- `/docs/*` proxies the dedicated versioned documentation service; generated MkDocs HTML remains outside git and outside the dashboard image.

## 4.0.24 - 2026-07-08

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.24 | Ships dashboard UI polish, Material Icons, service dependency warnings, and profile cleanup. |
| api | 0.5.6 | Keeps service overview counts aligned with stopped/failed local service state and removes avatar upload handling. |
| dashboard-gateway | 0.1.7 | Supports refreshed dashboard handoff/update behavior for the polished dashboard bundle. |
| update/ops | 0.5.8 | Refreshes local development rules and installed global-rule templates based on the configured agent ecosystem. |
| docs | 0.2.2 | Documents Chrome-driven dashboard development and setup/update rule refresh behavior. |

- Dashboard controls now use local Material Icons and shared custom components for sidebar actions, modals, tooltips, toggles, checkboxes, selects, and memory-row actions.
- Notifications, System Settings, Services, Workers, Token usage, Memories, and Overview widgets now share tighter standard layouts with less blinking, better table sizing, reusable log rendering, and clearer status badges.
- Services now treats clean `Exited (0)` stops as stopped, warns before stopping dependencies, and marks directly impacted services with a tooltip when an upstream dependency is stopped or failed.
- Profile avatar upload and image-resize handling have been removed so the profile modal stays focused on account details.
- The update/setup rules now refresh global agent instructions according to the installed ecosystem and document Chrome-first dashboard development expectations.

## 4.0.23 - 2026-07-07

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.23 | Ships the teammate updater lockfile-drift hotfix as a detectable dashboard release. |
| update/ops | 0.5.7 | Preserves generated lockfile-only checkout drift before fast-forward update merges. |

- `npm run update-persistent-memory` now auto-stashes generated root/dashboard `package-lock.json` drift when those lockfiles are the only tracked local changes before an incoming current-branch update.
- Updates with other tracked local changes now stop before the merge with a clear affected-file list instead of reporting every merge failure as diverging local commits.

## 4.0.22 - 2026-07-07

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.22 | Polishes dashboard settings, services, workers, usage, and memory management layouts. |
| api | 0.5.5 | Exposes MCP session counts and service/log state for the dashboard overview and service tables. |
| mcp | 0.4.5 | Captures session-scoped request context so MCP session logs show agent communication instead of generic API noise. |

- Notifications and System Settings now share the reusable two-column settings shell without duplicate body titles, and section switches stay mounted without blinking.
- Services and Workers now use compact status controls with reusable live log previews/modals, and MCP sessions show a Logs column instead of the old control column.
- Service and worker log previews/modals now share one terminal-style `LogOutput` renderer with local/server time toggles, severity coloring, JSON-friendly rendering, and bottom-pinned autoscroll until the user scrolls up.
- Token usage separates chart window controls from lower table tabs, keeps Live bars on a fixed rolling timeline, removes the manual Refresh button, and adds selectable graph styles.
- MCP service logs now stay focused on daemon/internal output, while MCP session rows show session-scoped agent communication logs with request method, tool, path, status, timestamp, and timing metadata instead of repeated `api` messages.
- Overview now includes an MCP sessions widget that opens Services with the MCP sessions tab selected, and the fact-extraction / embeddings model cards deep-link to their matching System Settings sections.
- Memories list/tool tabs now live inside the Memories page content, and the table uses one shared fixed-width metadata/action template so headers and rows stay aligned while the memory text column gets the flexible width.
- The Total memories pill keeps its label and count aligned on one line.

## 4.0.21 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.21 | Adds reusable settings layout and real Chrome/browser Web Push registration. |
| api | 0.5.4 | Stores browser Push subscriptions and VAPID keys for local personal dashboards. |
| worker | 0.1.2 | Sends local personal security-alert notifications through browser Web Push. |

- Personal-space Notifications now uses a left settings list with Application updates and System notifications sections, so each setting opens in one standard right-side panel.
- System notifications now has a single **Enable Chrome/browser notifications** control; the redundant Enabled checkbox, green browser-profile description, and status badge are removed.
- Chrome/browser notification enablement now registers a service worker, saves a Push subscription server-side, sends a server-pushed test notification, and uses Web Push delivery for personal memory changes and security alerts.
- Custom dropdown hover states now stay neutral instead of flashing the global blue button hover color.

## 4.0.20 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.20 | Ships the teammate HTTPS update-auth fix as a detectable release. |
| update/ops | 0.5.6 | Uses the configured Bitbucket token for HTTPS git fetch during updates. |
| update-runner | 0.3.4 | Matches terminal update git-fetch authentication behavior. |

- `npm run update-persistent-memory` now uses the saved Bitbucket update token through a temporary Git askpass helper when the checkout uses an HTTPS Bitbucket remote, so teammate installs do not hit an unexpected interactive username/password prompt mid-update.
- Git fetch is non-interactive during updates; if credentials are unavailable or invalid, the script fails fast with a clearer VPN/Git credentials/token message.

## 4.0.19 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.19 | Release candidate test for teammate-side update verification. |

- Test release candidate only. Use this release to verify teammate installs see the dashboard update notification, run the update flow, and open the release notes after the update completes.

## 4.0.18 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.18 | Clarifies personal notification delivery as browser-origin notifications. |
| worker | 0.1.1 | Suppresses external alert fan-out for local personal deployments. |
| update-runner | 0.3.3 | Adds a redacted update-notification settings artifact to update snapshots. |
| update/ops | 0.5.5 | Captures update-notification settings in terminal update snapshots. |

- Personal-space System Notifications no longer exposes email recipients or minimum severity controls.
- The former Laptop notifications toggle is now Chrome/browser notifications, migrates the old local setting, requests browser permission on user action, and sends a small test notification when permission is granted.
- Personal notification preferences now include checkboxes for new releases, memory added, memory updated, memory removed, and security alerts; the dashboard uses them for update availability, personal memory edit/import/delete completion, and new open security-alert counts while the browser is open.
- Local personal workers now skip email/Slack fan-out from `notify_settings`, so stale personal rows cannot send external notifications after the UI removed those controls.
- Update snapshots now include `update-notification-settings.json` next to the copied `.env.persistent-memory`, making Bitbucket update-notification backup state easy to verify while keeping the token redacted in the focused artifact.

## 4.0.17 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.17 | Ships the matching reloaded-tab update screen as a detectable dashboard update. |
| dashboard-gateway | 0.1.6 | Aligns the standalone update shell with the in-dashboard handoff overlay. |
| update/ops | 0.5.4 | Refreshes only the dashboard gateway shell before the main stack rebuild. |

- Reloading the dashboard during `npm run update-persistent-memory` now shows the same compact update card style as the original in-dashboard overlay: same title row, spinner, progress bar, and three-card phase/version/updated grid.
- The terminal updater now rebuilds and refreshes only `dashboard-gateway` before the main rebuild, waits for the gateway health endpoint, then recreates the rest of the stack with the gateway excluded.

## 4.0.16 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.16 | Ships the terminal-update gateway stability fix as a detectable dashboard update. |
| update/ops | 0.5.3 | Keeps the running dashboard gateway out of the terminal updater's Compose recreate set. |

- `npm run update-persistent-memory` now rebuilds the `dashboard-gateway` image without stopping the running gateway, then recreates the rest of the stack so `127.0.0.1:3200` stays bound during update handoff.
- Open dashboard tabs render the already-loaded dashboard overlay, while reopened tabs render the gateway's standalone update shell; both read the same handoff state, and the standalone shell can trail gateway visual changes until the next gateway restart.

## 4.0.15 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.15 | Adds Stream MCP session timeout settings and countdowns. |
| api | 0.5.3 | Persists the configurable Stream MCP idle timeout and exposes MCP session deadlines. |
| mcp | 0.4.4 | Closes idle stream sessions after the configured timeout while preserving stale-session recovery. |

- Stream MCP sessions now expire after 15 minutes of real MCP inactivity by default; heartbeats keep dashboard rows alive but do not extend the activity deadline.
- System Settings now includes a Stream service session timeout card; saving the value restarts the Stream MCP service so the new policy applies.
- Services > MCP sessions now shows a live Terminates at countdown derived from last activity and the configured timeout.

## 4.0.14 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.14 | Switches Token usage charts from interpolated lines to bucket bars. |

- Token usage now renders Live, `24h`, `7d`, `30d`, and `90d` trend data as vertical bars, so sparse request buckets no longer look like usage grew gradually between points.
- Date-range charts now plot bucket token totals rather than cumulative chart points; the totals cards still show the selected-window aggregate.

## 4.0.13 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.13 | Makes Token usage range chart X-axis labels date-aware. |

- Token usage Live remains time-only, `24h` now labels ticks with date plus time, and `7d`, `30d`, and `90d` use date labels so cross-day range charts are easier to read.

## 4.0.12 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.12 | Makes the update progress bar read as an actual filled green bar. |
| dashboard-gateway | 0.1.5 | Uses the same bright filled progress bar for reopened update tabs. |

- Update handoff progress bars now use an explicit bright green gradient fill with an inset highlight instead of a darker fill plus outer glow, so the filled portion is visually obvious while the updater runs.

## 4.0.11 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.11 | Fixes the update overlay title size, visible green progress fill, and Token usage range charts. |
| dashboard-gateway | 0.1.4 | Matches the compact update title and green progress fill for reopened dashboard tabs. |

- Update handoff titles now render at 18px in both the in-dashboard overlay and the gateway shell.
- The progress bar fill now uses the defined green status token/hex instead of the missing `--success` variable, so the bar visibly fills according to the progress percentage.
- Token usage charts now keep Live as a rolling 10-minute delta graph while `24h`, `7d`, `30d`, and `90d` render their own cumulative date-range trends without reusing Live samples.

## 4.0.10 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.10 | Makes the update overlay compact and turns Live token usage into a rolling graph. |
| dashboard-gateway | 0.1.3 | Uses the same compact update title and visible progress fill for reopened dashboard tabs. |

- Update handoff titles now use compact inline typography so the spinner and release title sit on the same row without the hero-scale wrap.
- Progress bars now paint a high-contrast fill with a small minimum visible width whenever progress is above zero, so the percent text and bar agree visually.
- Token usage Live now samples the current total on each 10-second poll and plots the last 10 minutes as one-minute buckets with a moving endpoint instead of drawing a static diagonal from zero to the current total.

## 4.0.9 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.9 | Keeps the Live Token usage graph visible and moves the Recharts trend below the totals. |

- Token usage now renders the Recharts trend chart for the Live window even when the backend returns no trend buckets yet, using a moving 10-minute baseline that updates with the 10-second poll.
- The usage totals and graph are stacked in the card: totals stay on the first row, and the full-width chart lives beneath them with the same axes and tooltip behavior.

## 4.0.8 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.8 | Shows the dashboard update gateway polish as a detectable dashboard update after `4.0.7`. |
| dashboard-gateway | 0.1.2 | Adds a visible spinner, progress bar, and dashboard readiness endpoint for update handoff screens. |
| update/ops | 0.5.2 | Writes progress percentages and marks the update complete only after final output plus dashboard readiness. |

- The gateway update screen now shows a spinner and progress bar while `npm run update-persistent-memory` advances through snapshot, pull, rebuild, verification, and final readiness phases.
- Reopened dashboard tabs stay on the update screen after the script reaches completion until `/api/update/dashboard-ready` confirms the refreshed dashboard can accept traffic.
- The terminal updater now waits for the refreshed dashboard before writing the final `complete` handoff state, so users do not get released into a half-ready dashboard.

## 4.0.7 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.7 | Ships the gateway proxy fix as a detectable dashboard update after `4.0.6`. |
| dashboard-gateway | 0.1.1 | Stops forwarding compression negotiation upstream and strips decoded compression headers before returning dashboard pages to the browser. |

- Fixes the post-update black screen where the gateway returned already-decoded Next.js HTML while still forwarding `content-encoding: gzip`.
- Dashboard pages now load normally through `localhost:3200` after the gateway handoff completes.

## 4.0.6 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.6 | Adds a stable dashboard update handoff so tabs no longer reload into a half-ready app during terminal updates. |
| dashboard-gateway | 0.1.0 | Owns `localhost:3200`, proxies normal dashboard traffic to admin, and serves the update progress shell while admin is rebuilt. |
| update/ops | 0.5.1 | Writes file-backed update handoff state before, during, and after update phases for open and reopened dashboard tabs. |

- `localhost:3200` is now served by `persistent-memory-dashboard-gateway`; the Next.js admin container is internal-only on port 3000.
- During `npm run update-persistent-memory`, the script writes `.local/update-state/dashboard-handoff.json` so existing tabs show a blocking overlay and reopened tabs see a lightweight update screen instead of a transient server-side error page.
- Release notes still open automatically after the update completes, but the browser now reloads only after the handoff reaches `complete` and the dashboard readiness probe passes.

## 4.0.5 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.5 | Guards post-update auto reload until the dashboard is ready and replaces the custom Usage sparkline with a Recharts token trend chart. |

- Open dashboard tabs now wait for `/api/update/reload-ready` before reloading into a newly deployed dashboard, avoiding transient server-side error pages during update handoff.
- Token usage now uses Recharts for the responsive token-over-time chart with real axes, grid, tooltip, and line rendering instead of a custom SVG/CSS sparkline.

## 4.0.4 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.4 | Makes post-update release-note handoff more responsive and expands the Token usage chart into a full-width axes-labeled plot. |
| api | 0.5.2 | Marks MCP heartbeat responses as registered or missing so clients can restore session rows after an API restart. |
| mcp | 0.4.3 | Re-registers active stream sessions when heartbeat detects the API session registry was reset. |

- Open dashboard tabs now poll update status every 10 seconds in steady state, and every 2 seconds while an update is available or running, so terminal updates can reload and open release notes without waiting for a manual refresh.
- The Services MCP sessions table recovers after API restarts: if the API lost its in-memory session registry, the next MCP heartbeat re-registers the active client.
- Token usage now plots trend points sorted by timestamp, uses the available horizontal space, and labels the Y axis as Total tokens and the X axis as time.

## 4.0.3 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.3 | Adds automatic refresh to Services and every Token usage window, fixes the Workers page header title, and moves Memories tabs into the page body. |

- Services now polls every 10 seconds with an overlap guard, so newly connected MCP clients and service state changes appear without a browser reload.
- Token usage now polls the currently selected window every 10 seconds, including 24h, 7d, 30d, and 90d filters, not only Live.
- Workers now has explicit header copy in server and local dashboard modes instead of falling through to the Memories page title.
- Memories now keeps the Memory List / Memory Tools selector in the page content immediately above search filters instead of in the dashboard header.

## 4.0.2 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.2 | Moves Services and Memories tab controls into the dashboard header top panel instead of rendering them inside the page body. |
| mcp | 0.4.2 | Returns standards-compliant Streamable HTTP session errors so clients can reinitialize after the stream MCP service restarts during an update. |

- Services now switches between Application Services and MCP sessions from the centered header tab strip, leaving the page body to start with the service summary and table.
- Memories now switches between Memory List and Memory Tools from the centered header tab strip, keeping search/filter controls at the top of the body.
- The header tab state is URL-backed so tab selection survives reloads and stays aligned with the rendered page content.
- Stream MCP now returns JSON-RPC `Session not found` with HTTP 404 for stale `Mcp-Session-Id` values after a restart, allowing clients to start a fresh session instead of getting stranded on `invalid_or_missing_mcp_session`.

## 4.0.1 - 2026-07-06

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.1 | Finishes the Personal/Shared space switch, Shared Memories connection page, personal-space cleanup, overview auto-refresh, compact Services/Memories tabs, and personal notification cleanup. |
| api | 0.5.1 | Tightens Shared Memories connector validation and returns retryable extraction-provider overload/rate-limit failures before persistence. |
| mcp | 0.4.1 | Extends memory API timeout handling, reports transient extraction-provider failures clearly, and keeps personal/shared identity routing aligned. |
| docs/rules | 0.5.1 | Clarifies global versus project-local persistent-memory rule paths for Codex and Claude registrations. |

- The dashboard now has a dedicated Personal/Shared space switch. Unconnected Shared Memories show only the Connection page; connected Shared Memories show live connection state and refresh role/permission-driven navigation on reconnect.
- Personal Memories views are team-free: team widgets, team settings, team menu affordances, and personal export team metadata stay out of the personal surface.
- Overview widgets refresh automatically, and Services/Memories tabs now live in the top panel so dense tables keep more usable vertical space.
- Personal notification settings use the profile email and no longer expose team-target or Slack-delivery controls in the personal space.
- Shared Memories connection validation checks the connector token identity against the local profile email before saving the connection.
- Fact extraction provider overload and rate-limit failures now return retryable API errors before memory persistence, and MCP messages explain that the memory was not saved instead of implying a local stack outage.
- Codex/Claude project guidance now states that Global Level installs use `~/.codex/rules/persistent-memory.md` and `~/.claude/rules/persistent-memory.md`; project-local rule files are created only by Project Level registration.

## 4.0.0 - 2026-07-05

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 4.0.0 | Becomes the single local management surface for Personal Memories plus optional Shared Memories, with team-free Personal views, shared connection controls, and server-dashboard super-admin gating. |
| api | 0.5.0 | Adds Shared Memories connector storage/test endpoints, a minimal connector-token minting route, embedding-topology aliases, and local/server dashboard access enforcement. |
| mcp | 0.4.0 | Makes the stream MCP service the only generated runtime and loads Personal/Shared surface configuration from the local stack. |
| onboard installer | 0.7.0 | Reworks install into personal-first setup followed by optional Shared Memories connection validation. |
| update/ops | 0.5.0 | Adds an interactive uninstall command with optional team-free JSON or encrypted personal memory export before container removal. |
| database | 0.3.0 | Adds Shared Memories connector fields to system settings for the local stack. |
| docs | 0.5.0 | Replaces legacy mode/runtime language with server-managed/client-managed embeddings and stream MCP guidance. |

- One client install now creates the local Personal Memories stack, local embeddings, local dashboard account at `http://localhost:3200`, and stream MCP service first.
- The wizard asks about Shared Memories only after personal setup. When selected, it collects the connector token, calls remote `/config` and `/whoami`, checks role plus embedding topology/model/dim, saves the connection, and restarts stream MCP best-effort.
- The dashboard adds Shared Memories connection management. The Personal view uses the local stack with local superuser rights; the Shared view proxies remote calls with the stored connector token and shows only what the server role allows.
- Shared-only server dashboards route Shared Memories directly to their own API, while local personal dashboards use the saved connector proxy only after Shared Memories are connected.
- Shared Memories connector management is local-mode only; raw connector tokens are not exposed from the shared server dashboard.
- Personal Memories no longer expose team UI or export metadata: the memories table hides the team column, local chrome hides super-admin/team badges, personal import/export omits team flags, and team-scoped controls stay in Shared Memories.
- The server dashboard is super-admin-only in server mode. Regular users and team admins authenticate to the shared server only to mint/use connector tokens, not to operate the global server console.
- User-facing topology names are now **server-managed embeddings** and **client-managed embeddings**. Legacy `server` / `client-bridge` wire values remain migration aliases.
- New registrations use only stream MCP. Legacy command-based persistent-memory registrations are upgraded to the stream URL by setup/update helpers.
- Project-built Docker images now use `latest` tags in Compose so teammate installs no longer populate `persistent-memory-* :dev` images.
- `npm run uninstall-persistent-memory` now checks for memory records, offers standard JSON or encrypted `.pm` personal export in the repository root without team fields, then removes Compose containers/network while preserving Docker named volumes.
- Project-level Claude/Codex instructions are now short operating contracts, with durable rules split under `.claude/rules/` and `.codex/rules/`; internal development plans belong in `.local/documents/`, not committed docs.

## 3.10.0 - 2026-07-05

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.10.0 | Replaces normal server-mode token login with email/password sessions, SSO-mode login card, recovery-token fallback, temporary-password warning, profile password changes, and super-admin password resets. |
| api | 0.4.0 | Adds dashboard password login sessions, login-mode configuration, password strength enforcement, temporary-password metadata, and super-admin reset endpoints while preserving PM tokens for MCP/API/recovery. |
| onboard installer | 0.6.0 | Detects server dashboard login mode during client setup and updates injected agent rules for Personal Memories versus Shared Memories project choices. |
| database | 0.2.0 | Adds dashboard login mode and password lifecycle columns for user rows. |
| docs | 0.4.0 | Documents dashboard human login, recovery tokens, SSO mode, and project memory-surface selection behavior. |

- Server-mode dashboard login now uses email/password for human sessions; PM tokens remain the credential for MCP/API automation and recovery access.
- Server bootstrap seeding generates a temporary super-admin password and still prints a show-once recovery/MCP token.
- Users with temporary passwords see a yellow top banner until they change the password in the profile modal; a super-admin's first temporary-password change rotates and shows a recovery/MCP token once.
- Profile password changes require the current password, a matching confirmation, and a strong new password with a red/yellow/green strength meter.
- Super-admins can reset any user's password from Users and receive a generated temporary password shown once for copy.
- System Settings now includes a dashboard-login mode switch. SSO mode changes the login page to an SSO card while preserving recovery-token fallback.
- Tokens are treated as recovery credentials in the dashboard and the Tokens page is super-admin-only.
- Server-connected onboarding reads `/config.dashboardLoginMode`; password-mode servers require dashboard password setup, while SSO-mode servers tell users to use their work email for dashboard login.
- Injected Claude/Codex memory rules now require a per-project Personal Memories versus Shared Memories choice when both surfaces are configured and say to park that surface under project-level agent config.

## 3.9.2 - 2026-07-05

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.9.2 | Polishes the server-managed/client-managed embeddings admin validation experience across services, teams, notifications, tokens, mounts, settings, and profile avatars. |
| api | 0.3.1 | Stores the issue timestamp for the active user token and clears it on revoke. |
| onboard installer | 0.5.4 | Connects server-backed personal installs before account setup and enabled both stream and the now-legacy command-based MCP path for server-managed/client-managed embeddings client installs. |
| update/ops | 0.4.2 | Adds prompt-driven isolated server installers for client-managed embeddings and server-managed embeddings validation/deployment, with host-port preflight checks and bootstrap super-admin identity prompts. |
| docs | 0.3.3 | Documents the operator-only server-side scripts and shared-only client stream MCP behavior. |

- Added the now-legacy `scripts/install-server-mode-b.sh` and `scripts/install-server-mode-a.sh` aliases for manual server-side Phase 3 validation.
- Each script prompts for deployment settings, writes mode-specific env/Compose override files under `.local/`, and starts an isolated Docker Compose project only after confirmation.
- client-managed embeddings defaulted to an isolated client-managed validation project with `EMBEDDING_MODE=client-bridge`; server-managed embeddings defaulted to an isolated server-managed validation project with server-side embeddings.
- Server-side scripts do not install or start MCP; server-managed/client-managed embeddings client onboarding owns MCP registration and client-local embedding setup.
- Host-side migrate/seed steps inherit the generated mode env so bootstrap tokens and stored embedding settings match the running server.
- The scripts do not remove containers, volumes, or env files, and they preserve existing mode secrets on rerun.
- The installers check requested host ports before `docker compose up` creates a partial stack.
- The server-side scripts now ask for the bootstrap super-admin email/display name and write them into the generated mode env before seeding.
- server-managed/client-managed embeddings client installs with isolated personal memory now connect to the server before account setup; the account step copies team/email from the server `/whoami` token identity, leaves only display alias/password editable, and requires the local dashboard password.
- The server-managed/client-managed embeddings connection step now calls out the local server API port when users enter a bare loopback URL such as `http://127.0.0.1`.
- server-managed/client-managed embeddings client installs could choose stream or the now-legacy command-based MCP path regardless of whether isolated personal memory was enabled.
- Shared-only server-managed/client-managed embeddings stream installs build and start only the local `persistent-memory-mcp` container against the remote server; they do not install a local server stack.
- Stream MCP installs rewrite loopback shared-server URLs such as `http://127.0.0.1:12090` to `http://host.docker.internal:12090` for the Docker MCP container.
- client-managed embeddings personal-stack installs now map the server `/config` embedding pin from `activeModel`/`activeDim` before rendering the local `.env`, preventing `ollama pull undefined`.
- Services now separates Application Services and MCP sessions into tabs.
- Notifications now use a target list: super-admins can configure System Notifications plus each team, while team admins see only their own team.
- Teams now uses reusable modals for rename/delete actions instead of browser confirmation prompts.
- Custom select and token-expiry popovers render above scroll containers so last-row dropdowns remain usable.
- Tokens now record and display the active token's issue date, and token expiry uses an in-app date/time picker instead of the browser calendar.
- Mounts now use a reader-focused editor with the shared checkbox component.
- client-managed embeddings System Settings now shows the embedding pin as read-only client-bridge configuration.
- Profile avatar uploads are normalized to a 512x512 WebP before storage, with friendly validation errors for invalid images.

## 3.9.1 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.9.1 | Updates the visible product release for the update-script agent-artifact migration. |
| onboard installer | 0.5.1 | Exposes a reusable agent refresh helper that safely updates existing Claude/Codex memory prompts and MCP registration artifacts. |
| update/ops | 0.4.1 | Runs the agent refresh helper during `npm run update-persistent-memory` after runtime verification. |
| docs | 0.3.1 | Documents that updates now carry generated prompt/rule/MCP registration changes forward for existing installs. |

- `npm run update-persistent-memory` now refreshes existing persistent-memory Claude/Codex MCP registrations and generated prompt/rule blocks after a successful runtime update.
- Existing older updater scripts also pick up this refresh through the post-pull `npm run setup` bridge, so one normal update command carries the new agent prompts forward.
- The refresh preserves sibling MCP servers, preserves existing remote node-MCP API/token values when `.env.persistent-memory` cannot infer them, and skips unrelated agent files.
- Existing `.env.persistent-memory` behavior remains secret-preserving: new template keys are backfilled, machine-owned secrets are generated when missing, and real local values are not overwritten.

## 3.9.0 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.9.0 | Updates the visible product release for the graph-first agent memory protocol. |
| mcp | 0.3.0 | Adds `recall_context`, the graph-first task-start memory tool with connected memories, graph facts, entity expansions, timeline, and contradictions. |
| onboard installer | 0.5.0 | Writes Claude/Codex rules that require `recall_context` first and registers Claude MCP entries with `alwaysLoad:true`. |
| docs | 0.3.0 | Documents the graph-first agent protocol, research basis, tests, live benchmark, and Claude validation prompt. |

- Added `recall_context` so agents retrieve the full memory picture in one call instead of relying on flat semantic search.
- Added MCP initialize instructions and tool metadata to push Claude/Codex toward graph-first recall before planning or editing.
- Updated wizard-injected prompts to load deferred memory tools through ToolSearch/tool_search and to treat `search_memories` as a follow-up, not the first read.
- Added deterministic MCP tests plus an opt-in live benchmark that seeds connected memories and verifies the graph/timeline picture after reinstall.

## 3.8.1 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.8.1 | Prevents post-update release notes from reopening when a later completion marker reports the same already-shown version. |
| mcp | 0.2.1 | Treats blank optional personal/shared surface env values as unset so personal-only installs do not fail URL validation. |
| docs | 0.2.1 | Documents blank optional MCP surface envs and the post-update release-note shown-version guard. |

- Fixed the MCP stream service restart loop caused by `PM_SHARED_API_URL=` in personal-only/full-local `.env` files.
- Fixed post-update release notes so closing the modal sticks even if update status later returns a `lastSuccessfulUpdate` marker for the same release.

## 3.8.0 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.8.0 | Adds Personal Memories / Shared Memories navigation and surface-aware memory page API routing. |
| mcp | 0.2.0 | Adds explicit `surface` routing for memory tools and resolves personal/shared API runtimes independently. |
| onboard installer | 0.4.0 | Adds the isolated personal memory setup branch for full-local, server-managed embeddings, and client-managed embeddings installs. |
| update/ops | 0.4.0 | Backfills and reconciles memory-surface env keys safely for existing local installs. |
| docs | 0.2.0 | Documents the Phase 3 personal/shared memory architecture and setup behavior. |

- Full-local installs now default to Personal Memories only.
- Server-connected installs can opt into isolated personal memories from the first wizard screen; that branch installs a local private stack and registers MCP routing so personal writes stay local while shared writes/searches can target the company server.
- MCP memory tools now accept optional `surface: "personal" | "shared"` and default to the configured surface.
- The dashboard memory page can show Personal Memories and Shared Memories as separate left-nav entries when both surfaces are configured.

## 3.7.6 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.7.6 | Opens post-update release notes from the reload handoff or completion marker without requiring the update checker gate. |
| docs | 0.1.15 | Documents the corrected post-update release-note handoff. |

- Fixed the post-update release-note modal so it is no longer blocked by the update-notification permission gate after the dashboard reloads.
- Added a one-time completion-marker fallback: if the pre-reload localStorage handoff is missing, the reloaded dashboard can still open release notes from `lastSuccessfulUpdate` and mark that marker as seen.

## 3.7.5 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.7.5 | Fast-polls pending update status, reloads from the terminal-update completion marker, and opens release notes once after reload. |
| update-runner | 0.3.2 | Exposes the last successful terminal/dashboard update marker in update status. |
| update/ops | 0.3.2 | Writes a local post-update success marker at the end of `npm run update-persistent-memory`. |
| docs | 0.1.14 | Documents the marker-driven dashboard reload behavior. |

- `npm run update-persistent-memory` now writes `.local/update-state/last-successful-update.json` after a completed update, so already-open dashboard tabs have a deterministic local signal to reload from.
- The dashboard polls update status every 2 seconds only while an update is pending, then returns to the normal 60 second cadence.
- Post-update release notes now open when the reloaded bundle is at or newer than the pending update version, avoiding the exact-version mismatch that could suppress the modal.

## 3.7.4 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.7.4 | Auto-reloads open dashboard tabs after a deployed update and opens release notes once. |
| docs | 0.1.13 | Documents post-update dashboard reload behavior. |

- Open dashboard tabs now detect when the deployed dashboard version becomes newer than the loaded browser bundle, reload automatically, and open the release notes modal once after reload.
- If no dashboard tab is open, nothing runs in the browser.

## 3.7.3 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.7.3 | Removes the update popup text-area hover highlight and leaves Details as the only action. |
| docs | 0.1.12 | Documents the update popup hover polish release. |

- The update-available popup text area is no longer a button, so hovering it no longer shows an accent highlight; users open details through the Details button.

## 3.7.2 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.7.2 | Removes duplicate Application updates summary badges from Notifications. |
| docs | 0.1.11 | Documents the update notification card polish release. |

- Removed the redundant enabled/provider/repository summary badges from the Application updates card because the editable fields already show those values.

## 3.7.1 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.7.1 | Updated the visible release version for the update-detection patch. |
| update-runner | 0.3.1 | Compares remote releases against the deployed dashboard release instead of only the bind-mounted repo package. |
| docs | 0.1.10 | Documents deployed-dashboard version detection for update prompts. |

- Fixed a local-development edge case where the repo worktree was already pulled to the latest version but the running dashboard image still served an older release.
- Update status now reads the deployed dashboard `release-history.md` when reachable, so the update popup still appears when containers need a rebuild.

## 3.7.0 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.7.0 | Adds a local-only Application updates settings card under Notifications. |
| api | 0.3.0 | Adds superuser-only `/dashboard/update/settings` read/write proxy routes. |
| update-runner | 0.3.0 | Reads and safely updates Bitbucket update-notification settings in `.env.persistent-memory`. |
| docs | 0.1.9 | Documents the dashboard-managed update notification settings release. |

- Local super-admins can now review and edit Bitbucket update notifications from Notifications, including enabled state, personal/project repo mode, owner, repo, branch, URL, and write-only token replacement.
- Disabled update notifications preserve the stored Bitbucket values so users can turn checks back on without re-entering the token.
- Server-side installs continue to suppress dashboard update-notification settings.

## 3.6.9 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.9 | Updated the visible release version for Bitbucket owner-scope support. |
| update-runner | 0.2.1 | Supports Bitbucket project repositories and personal user repositories when checking release metadata. |
| onboard installer | 0.3.1 | Adds a Bitbucket repository-owner selector for project repos versus personal repos. |
| update/ops | 0.3.1 | Validates Bitbucket project key or user slug based on `UPDATE_BITBUCKET_SCOPE`. |
| docs | 0.1.8 | Documents Bitbucket `projects/<key>` and `users/<slug>` update-check modes. |

- Added `UPDATE_BITBUCKET_SCOPE=project|user` and `UPDATE_BITBUCKET_USER` so personal repositories such as `/users/example.user/repos/example-service` work alongside project repositories such as `/projects/ENG/repos/example-service`.
- The full-local wizard now asks whether the Bitbucket repo is owned by a project or by a user account and validates the matching owner field.

## 3.6.8 - 2026-07-04

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.8 | Replaced dashboard one-click update controls with release notes and a copyable terminal update command. |
| update-runner | 0.2.0 | Added optional Bitbucket/Stash REST metadata checks for latest commit, product version, and release notes. |
| onboard installer | 0.3.0 | Added optional Bitbucket update-notification setup and blocks install when mandatory env values are missing. |
| update/ops | 0.3.0 | Backfills missing env-template keys, generates machine-owned secrets, removes the SSH mount knob, and validates deploy env before Compose. |
| docs | 0.1.7 | Documented Bitbucket-based update notifications, manual terminal updates, and strict env reconciliation. |

- Full-local dashboard update cards now use optional Bitbucket/Stash token metadata and no longer require or mount host SSH credentials.
- The dashboard modal now shows release notes plus `npm run update-persistent-memory`; users run the safe terminal updater manually.
- Installer/update/start/redeploy scripts preserve existing `.env.persistent-memory` values, append missing template keys, generate only machine-owned secrets, rebuild blank DB URLs, and fail before deployment if required values remain blank.

## 3.6.7 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.7 | Updated the visible release version for the verifier wait-state patch. |
| update/ops | 0.2.5 | Treats container `health=starting` as neutral `WAIT` progress instead of a warning during install/update verification. |
| docs | 0.1.6 | Clarified that transient healthcheck startup states are normal verifier wait output. |

- Removed noisy verifier warnings for containers that are running while their healthchecks are still starting.
- `scripts/verify-install.sh` now prints `WAIT` for this transient state and keeps `WARN` reserved for actionable concerns.

## 3.6.6 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.6 | Shows update notifications only for full-local installs and keeps the update card above dashboard layers. |
| update-runner | 0.1.4 | Makes update status polling silent when Git/VPN/auth metadata cannot be fetched. |
| docs | 0.1.5 | Clarified local-only dashboard update prompts and the SSH credential boundary. |

- Limited the dashboard update listener/card to `DEPLOYMENT_MODE=local` superusers; server/shared installs no longer poll or show update prompts.
- If update-runner cannot fetch fresh remote metadata, the dashboard now shows no update card and no warning noise.
- The update modal now points users to `npm run update-persistent-memory` as the default path and explains the explicit `PM_SSH_DIR` opt-in for one-click SSH updates.

## 3.6.5 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.5 | Updated the visible release version for the safer SSH update-runner flow. |
| update-runner | 0.1.3 | Falls back to cached `origin/<branch>` when `git fetch` cannot authenticate and makes SSH credentials opt-in. |
| update/ops | 0.2.4 | Changed the default update-runner SSH mount to an empty project-local directory unless `PM_SSH_DIR` is explicitly set. |
| docs | 0.1.4 | Clarified the explicit `PM_SSH_DIR` opt-in and cached-origin fallback behavior. |

- Made dashboard update checks safer for SSH remotes: no host SSH directory is mounted unless `PM_SSH_DIR` is explicitly configured.
- If fetch cannot authenticate, update-runner now uses the cached `origin/<branch>` ref when available instead of suppressing update status entirely.

## 3.6.4 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.4 | Updated the visible release version for the SSH remote update-runner fix. |
| update-runner | 0.1.2 | Mounted the host SSH directory read-only so update-runner can fetch SSH remotes. |
| update/ops | 0.2.3 | Added configurable `PM_SSH_DIR` Compose support for dashboard updates over SSH remotes. |
| docs | 0.1.3 | Documented the update-runner SSH credential boundary and `PM_SSH_DIR` override. |

- Fixed dashboard update checks for SSH remotes by giving update-runner read-only access to the host SSH config/keys.

## 3.6.3 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.3 | Updated the visible release version for the update-runner image fix. |
| update-runner | 0.1.1 | Added `openssh-client` to the update-runner image so SSH remotes can be fetched. |
| docs | 0.1.2 | Documented that update-runner includes Git and SSH client support for team checkouts. |

- Fixed dashboard update checks for SSH remotes by adding the missing `ssh` binary to the update-runner image.

## 3.6.2 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| update/ops | 0.2.2 | Made `npm run update-persistent-memory` generate missing sidecar tokens before Compose rebuilds. |
| docs | 0.1.1 | Clarified that updates preserve existing env values while backfilling newly introduced generated service tokens. |

- Fixed old installs that lacked `UPDATE_RUNNER_TOKEN`, which caused the update-runner sidecar to reject dashboard update requests with 401.
- The update script now backfills missing generated service tokens after the safety snapshot and before Compose interpolation.

## 3.6.1 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.1 | Softened the latest-release card background while keeping the green latest badge. |

- Improved release-note readability by reducing the intensity of the latest-release card background.

## 3.6.0 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.6.0 | Updated the visible release version for the Phase 2 release-model handoff. |
| docs | 0.1.0 | Formalized release/service version buckets, bump rules, and the release-entry template. |

- Completed the Phase 2 release version model: releases now have a documented product-version plus service/layer-version policy.
- Clarified that release entries list changed services/layers and unchanged service versions are inherited from the latest prior entry.

## 3.5.1 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.5.1 | Updated the visible release version for the verifier patch. |
| update/ops | 0.2.1 | Fixed `verify-install.sh` on macOS Bash 3.2 and added DLP, docker-control, update-runner, and stream MCP health checks. |

- Fixed the post-update verifier so it no longer crashes on macOS `/bin/bash` due to associative arrays.
- Expanded verification coverage to include the newly shipped update and operational sidecars.

## 3.5.0 - 2026-07-03

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 3.5.0 | Added update-available popup, centered update progress modal, and green latest-release cards. |
| api | 0.2.0 | Added `/dashboard/update` status/log/start routes as the RBAC choke-point for dashboard updates. |
| update-runner | 0.1.0 | Added the restricted internal update sidecar for snapshot, git fast-forward, rebuild, migration, RLS, and verification flow. |
| update/ops | 0.2.0 | Added `.local/update-backups` snapshot artifacts for dashboard, terminal, and old-updater bootstrap paths plus generated `UPDATE_RUNNER_TOKEN` setup. |
| onboard installer | 0.2.0 | Added update-runner token generation and masking to fresh wizard installs. |

- Added snapshot-safe updates: dashboard, terminal, and old-updater bootstrap paths snapshot local runtime data before rebuild/migration, then the dashboard path streams progress back to the modal.
- Added release-note parsing for product version plus per-service versions, with the latest release visually highlighted.
- Kept the update runner separate from `docker-control` so service control retains its smaller Docker verb boundary.

## 3.4.6 - 2026-07-03

- Fixed full-local install/restart Compose commands so API and worker containers always receive `.env.persistent-memory` during `${...}` interpolation, preventing `pm_app` database password drift after generated installs.
- Hardened `verify-install.sh` to fail when `pm_app` cannot authenticate with `PM_APP_PASSWORD` or when API/worker `DATABASE_URL` does not match the generated runtime password.
- Added onboarding regression coverage for explicit Compose env-file usage and tightened service-secret test fixtures.

## 3.4.5 - 2026-07-02

- Added a Memory Tools "Rebuild memory graph" action that queues a one-time worker job to replay existing memories through Graphiti with team, project, and author filters.
- Added a dedicated `pm.memory-graph-rebuild` queue/worker so graph rebuilds are operator-triggered jobs, not recurring scheduled jobs.
- Added memory-level Graphiti sync state plus the scheduled `memory-graph-backfill` safety net so normal memory create/update/import failures are retried like pending embeddings.
- Kept normal memory graph sync automatic by posting Graphiti episodes after data-plane/dashboard create, edit, and import paths and deleting memory episodes after single/bulk memory deletes.

## 3.4.4 - 2026-07-02

- Hardened local service exposure by binding developer-facing Compose ports to `PM_HOST_BIND=127.0.0.1` by default.
- Added generated `QDRANT_API_KEY` and `FALKORDB_PASSWORD` support, wired Qdrant/FalkorDB auth through Compose, and surfaced those credentials through the admin-only Services credentials modal.
- Clarified that the Graphiti service link opens API docs; graph records are stored in FalkorDB/Neo4j team graphs rather than a separate Graphiti visualization UI.
- Fixed Graphiti episode creation by no longer sending deterministic episode UUIDs that graphiti-core interpreted as existing-node lookups, leaving FalkorDB empty.
- Aligned Graphiti extraction auth with fact extraction so Anthropic `sk-ant-oat...` credentials use OAuth Bearer instead of being sent as `x-api-key`.

## 3.4.3 - 2026-07-02

- Fixed stream-mode onboarding for Claude Desktop by no longer writing HTTP MCP entries into `claude_desktop_config.json`; stream mode now writes Claude's `~/.claude.json` for Claude Code / Desktop folder sessions, while standalone Desktop chat stays on Custom Connectors or the now-legacy command-based config.

## 3.4.2 - 2026-07-02

- Fixed Claude stream MCP registration to use Claude's supported HTTP transport shape (`type: "http"`, `url`) instead of the SDK/internal `streamable-http` label, which caused Claude Desktop to skip `persistent-memory` as an invalid MCP server configuration.

## 3.4.1 - 2026-07-02

- Fixed onboarding memory block replacement so legacy `## Memory Save Triggers (MANDATORY)` sections are removed before the current `## Persistent Memory Usage (MANDATORY)` block is inserted.

## 3.4.0 - 2026-07-02

- Reworked Memory Tools import into an explicit staged flow: choose file, Load & verify, review the parsed package/scope, then Import & re-embed.
- Added visible import progress steps and inline error details for file verification failures and per-row backend import failures.

## 3.3.1 - 2026-07-02

- Fixed Memories import after fresh reinstall/restore by resolving stale exported team and author ids against the current control plane before creating rows, falling back to the current local team/user when appropriate.
- Changed Memories import notifications so an all-error batch is shown as an error and a partial import is shown as a warning instead of always displaying a green success toast.

## 3.3.0 - 2026-07-02

- Updated onboarding Memory rule step to show and write both the top `## Persistent Memory Usage (MANDATORY)` block and the detailed `persistent-memory.md` rule prompt.
- Reworked the memory writer to replace older generated persistent-memory blocks and legacy one-line refs before insertion, preventing duplicate memory guidance on reinstalls.
- Tightened the default persistent-memory rule prompt around retrieving the memory picture before non-trivial work, saving corrections/gotchas immediately, and reconciling stale memories.

## 3.2.2 - 2026-07-02

- Updated onboarding Ecosystem selection to show separate Codex CLI and Codex Desktop choices, while writing their shared Codex config once.
- Removed the ChatGPT Desktop manual setup option from onboarding detection, registration, rule, and done screens.

## 3.2.1 - 2026-07-02

- Polished the Memories filter bar: renamed the tab to Memory List, removed the explicit Search button, made text/team/project filters auto-apply, widened the search field, and moved the total counter to the right side.

## 3.2.0 - 2026-07-02

- Upgraded the dashboard from Next.js 15.1.8 to the patched 15.5.20 release with a PostCSS security override so Docker builds no longer emit the existing Next.js security warning and `npm audit` is clean.
- Changed Memories search to run exact dashboard text/project/category/entity matching first, returning a filtered total that matches the visible results; semantic vector search remains the fallback when no exact matches exist.
- Added scoped Memory Tools export/import controls for team and project, with secure `.pm` encrypted exports selected by default and standard JSON export still available.
- Added browser save-picker support for exports where available, with download fallback, and import auto-fill of team/project scope from `.json` or `.pm` file metadata.

## 3.1.1 - 2026-07-02

- Fixed fresh laptop Docker build reliability by adding retry/timeout hardening around Docker `npm ci` steps and removing duplicate production `npm ci` registry installs from API, worker, and MCP runtime stages; runtime images now reuse the dependency stage and prune dev packages locally.
- Limited onboarding and update Compose builds to one image build at a time by default to avoid concurrent npm registry/TLS failures such as `ERR_SSL_CIPHER_OPERATION_FAILED`.

## 3.1.0 - 2026-07-02

- Split the Memories page into centered Memory list and Memory Tools tabs, with Memory list selected by default.
- Added a filtered total to the Memory list toolbar so search/filter results show the current memory count.
- Moved dashboard memory tools into a vertical Memory Tools page with separate Export memory, Import memory, and Bulk delete cards.

## 3.0.0 - 2026-07-02

- Added the shared Streamable HTTP MCP service runtime for full-local installs, served as the Docker-managed `persistent-memory-mcp` Compose service on port 8091.
- Updated onboarding MCP registration with two explicit runtime choices at the time: shared stream service or the now-legacy command-based path. That legacy mode never created Docker MCP containers.
- Split Services behavior so the shared stream MCP service appears with Application services, while connected MCP clients appear in the MCP sessions card with connection type and cooperative Terminate for stdio clients.
- Added MCP session registry and heartbeat endpoints so stream and stdio clients can report active connections independently from Docker container discovery.
- Updated start, stop, update, verify, and safe redeploy scripts to include the `mcp-stream` profile automatically when `PM_MCP_RUNTIME=stream`.

## 2.6.2 - 2026-07-02

- Added a superuser-only **Terminate** action for MCP session rows on the Services dashboard, targeting the exact Docker container id/name and warning that active Codex/Claude sessions will disconnect until they reconnect or restart.
- Extended the docker-control sidecar with a separate MCP cleanup `terminate` verb while keeping `start`/`stop`/`restart` restricted to real Compose stack services.
- Clarified MCP stdio process behavior in the docs: multiple active containers can exist for the same registered client owner across windows, sessions, reloads, and app surfaces; they are not one container per tool call.

## 2.6.1 - 2026-07-02

- Split the Services dashboard into Application services and MCP sessions cards so per-client MCP containers no longer crowd the main stack health table.
- Fixed MCP session log actions to target the exact container id instead of the shared service label when multiple live sessions share names like `codex-mcp`.
- Documented that Docker-run MCP rows represent live stdio client processes, not duplicate registrations or one container per tool call.

## 2.6.0 - 2026-07-02

- Added Services discovery for project-labeled per-client MCP containers, including Codex/Claude stdio sessions, as read-only rows with logs while start/stop/restart stays limited to real Compose stack services.
- Moved release notes from the sidebar profile footer to a top-header info button after logout.
- Matched the top-header team badge height to the role badge and removed the remaining grid-table scrollbar gutter that left extra space on the right edge.

## 2.5.6 - 2026-07-02

- Removed the permanent grid-table row scrollbar gutter that left an empty right-side gap beside Memories table actions.

## 2.5.5 - 2026-07-02

- Fixed grid-table header jitter by keeping table headers outside the row scroll body; only rows now scroll inside Memories, Services, Workers, Usage, and Team tables.

## 2.5.4 - 2026-07-02

- Fixed dashboard table layout so table-heavy pages grow naturally until they reach the viewport, then scroll inside the table instead of the whole content pane.
- Restored grid-table scrollbars and moved Users/Tokens onto the same internal-scroll table pattern used by Memories, Services, Workers, Usage, Security, and Team.

## 2.5.3 - 2026-07-02

- Changed Docker MCP launchers from one shared static container name to per-client stdio containers named by owner, such as `codex-mcp`, `claude-code-mcp`, and `claude-desktop-mcp`.
- Documented that MCP containers are not shared or shown as dashboard Services because stdio transport is owned by a single client process.

## 2.5.2 - 2026-07-02

- Fixed Docker Desktop and Services monitor confusion from docker-run MCP clients inheriting Compose image labels; the MCP client image now builds with plain Docker and generated launchers use a stable `persistent-memory-mcp` container name.
- Removed the Services UI column; service names now open external UIs directly, and admin-only credentials open through a masked, read-only credentials modal.

## 2.5.1 - 2026-07-02

- Removed the generated Storybook export from the committed documentation surface.
- Ignored future `documentation/storybook/` exports and pointed the README/docs/protocol back to the Markdown documentation tree.

## 2.5.0 - 2026-07-02

- Added the Overview dashboard route and left-nav entry with clickable cards for team/user counts, service health, worker liveness, 24h token usage, saved memories, fact extraction, and embeddings.
- Renamed Usage to Token usage and added the By user requests tab with display name, email, total tokens, and request totals.
- Added System Settings controls for fact extraction model/API key, seeded fact-extraction testing, save-with-test behavior, embedding testing, and the Embeddings card title.
- Added the dashboard app version surface, release-history modal, and release-version maintenance protocol.
- Fixed fixed-shell behavior: sidebar and header stay in place, while table-heavy pages scroll internally.
- Polished Memories with full-row details opening, action-cell click isolation, full details badges, and shared project input styling.

## 2.4.0 - 2026-07-01

- Improved dashboard memory and service tables.
- Added richer service metadata and UI credentials handling through the admin/API/docker-control path.
- Refreshed admin/security/component documentation for the dashboard table behavior.

## 2.3.0 - 2026-06-30

- Polished admin controls: tool-row alignment, notifications dirty-state handling, uniform buttons, profile area polish, and PM Management branding.
- Made System Settings clearer with read-only install topology, model Select controls, dirty-gated saves, and no false A/B toggle.
- Fixed local installer prerequisites, Homebrew/env parsing, and MCP image build during full install.
- Moved Claude guidance into `.claude/` while preserving agent auto-load behavior.

## 2.2.0 - 2026-06-29

- Added the shared dashboard UI component library: Select, Input, Toast, Avatar, Modal, and FileInput.
- Redesigned the dashboard with the profile area, team name surface, optional-password login, and team settings.
- Wired the UI library across dashboard pages and gated install-type-specific surfaces.
- Redesigned Memories dashboard tools as named Export, Import, and Bulk delete tabs with team-scoped project controls.
- Applied local identity fixes, default QA team naming, and UI polish for full-local installs.

## 2.1.0 - 2026-06-29

- Refined the onboarding wizard: Haiku defaults, themed model picker, clearer Registration and Scope copy, project-folder picker, native folder chooser, and app-specific Memory-rule/Done steps.
- Added directory-aware MCP registration for Claude Desktop and Codex project scope.
- Pre-detected existing API keys from `.env.persistent-memory` while regenerating auto-secrets.
- Preserved DB/MinIO passwords across re-installs and stopped minting bootstrap tokens in local mode.

## 2.0.0 - 2026-06-29

- Introduced the full-local account redesign backend: local dashboard password, profile/avatar APIs, local auth routes, and Slack bot notification support.
- Added account and notification schema support.
- Extended worker notifications and tests for local-account behavior.

## 1.8.0 - 2026-06-28

- Added fully-local deployment mode: a single-user no-auth stack with DB-backed local identity.
- Made local mode a deploy-time pin for the API and dashboard surfaces.
- Updated installer/Dashboard behavior so local installs do not require a wire token.

## 1.7.0 - 2026-06-28

- Added document lifecycle support: dedup by project/filename, version-in-place, and guarded 4-store document delete.
- Closed concurrent upload and retry/orphan Qdrant cleanup review findings.
- Bounded worker ingest memory with capped reads and container memory limits.

## 1.6.0 - 2026-06-28

- Added dashboard-driven embedding model/dimension switching.
- Implemented no-blackout re-embed flow with switch status visibility.
- Kept model/dimension pin changes as a migration path rather than a live semantic toggle.

## 1.5.0 - 2026-06-28

- Added memory provenance, confidence, verification, tiers, access tracking, and soft-archive lifecycle.
- Added injection-safe reranking that discounts unverified/low-confidence memories.
- Added dashboard verification controls and retention configuration foundations.

## 1.4.0 - 2026-06-28

- Added fail-closed PII/secret scanning for memory writes and document ingestion.
- Added DLP sidecar integration, periodic scan worker, security alerts, and notification settings.
- Ensured raw sensitive values are not persisted in findings.

## 1.3.0 - 2026-06-27

- Added the managed scheduled-worker subsystem.
- Added pending-embedding backfill worker support.
- Added ingest reconciler plus fail-closed enqueue handling.

## 1.2.0 - 2026-06-27

- Removed the mem0 migration feature from the application surface.
- Closed cross-team import, universal-read leak, and onboarding DNS-rebinding findings.
- Fixed edit-time vector synchronization, orphan-free re-embed behavior, and graph-status tracking.
- Added and greened the live integration harness with Haiku extraction and meaningful entities.

## 1.1.0 - 2026-06-26

- Added model-usage instrumentation and the original Usage dashboard.
- Applied the product-owned dark admin/onboard design direction.
- Opened Services and Usage read access to members while keeping mutations superuser-gated.

## 1.0.0 - 2026-06-26

- Delivered the first productized application milestone after the initial platform build.
- Reworked the access model around nullable team membership, admin levels, mounted-team reads, universal dashboard reads, and RLS-backed write boundaries.
- Added dashboard memory management, export/import, flow-routed onboarding, and the Services monitor.
- Added docker-control sidecar support and expanded live verification around admin/dashboard access.

## 0.9.0 - 2026-06-24

- Built the first complete persistent-memory platform shape: Docker stack, Postgres/RLS, Fastify API, Qdrant embeddings, Graphiti service, MinIO ingestion, worker, MCP, dashboard app shell, and lifecycle scripts.
- Added the memory protocol, document/graph/investigation endpoints, and synthetic mem0 migration tooling.
- Added build-state and Storybook documentation snapshots for the initial implementation.

## 0.1.0 - 2026-06-24

- Created the repository baseline.
