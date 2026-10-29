# Release History

<!-- persistent-memory-release-line: public-v1 -->

## 2.0.1 - 2026-10-29

[GitHub release v2.0.1](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v2.0.1)

| Service | Version | Change |
| --- | --- | --- |
| api / worker / shared | 2.0.1 | Use a maintained S3 client adapter for local evidence storage without vulnerable parser dependencies. |
| dashboard / docs | 2.0.1 | Release metadata, patched diagram renderer and current security/validation documentation. |
| onboarding / database / schema / mcp / graph | 2.0.0 | Existing Community knowledge contracts and installation flow retained. |
| security-dlp / update-runner / update-coordinator | 1.0.1 | Existing scanner and updater contracts retained. |

- Add GitHub-hosted validation for pull requests and development/release pushes:
  clean locked installations, tests, type checks, production builds, documentation
  and release/upgrade contracts. Also check the supported Node 22 host/storage path.
- Audit all four npm lockfiles, including development and documentation packages.
  Any reported finding, including low severity, or an unavailable/incomplete audit
  fails validation. The corrected dependency trees report zero known npm findings.
- Replace the obsolete storage-client parser dependencies behind the existing
  local S3 interface. Preserve the MinIO server, endpoint, credentials, buckets,
  object keys, streaming uploads/downloads, metadata and signed download links.
  No AWS account, data migration or external storage connection is introduced.
- Patch the math renderer used by the documentation CLI and record the actual
  renderer version in regenerated diagram assets. Document the security checks
  and release verification procedure.

Existing Community 2.0 memory contracts, ownership, privacy gates and embedding
configuration remain unchanged. Public 1.0.0–1.3.1 installations still stop at
1.3.2 before this major line. Preserve the supported updater snapshot/recovery path.

To update, run from the repository directory:

```sh
npm run update-persistent-memory -- --release 2.0.1
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 2.0.1`.
For a new installation, follow the
[v2.0.1 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v2.0.1/README.md).

## 2.0.0 - 2026-10-29

[GitHub release v2.0.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v2.0.0)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / docs / onboarding | 2.0.0 | Community branding, classified forms and personal-only setup. |
| api / worker / database / shared / schema | 2.0.0 | Authoritative classified records, accepted revisions, source events and ownership-preserving migration. |
| mcp / mcp-runtime / graph | 2.0.0 | Personal-space recall, canonical write discovery and revision-fenced graph evidence. |
| memory-vector / evidence-files / security-dlp | 1.0.0 / 1.0.0 / 1.0.1 | Existing embedding model, evidence storage and content gates retained. |
| update-runner / update-coordinator / gateway / docker-control | 1.0.1 / 1.0.1 / 1.0.0 / 1.0.0 | Existing snapshot, updater, front door and service control contracts retained. |

- Community operates on one validated personal owner space. Shared connectors,
  grants, surface selection and remote fallback are retired. Legacy partitions,
  credentials and schema history remain preserved; they confer no access.
- New saves require contract v2 classification, origin, applicability, source
  evidence and idempotency. Updates require an exact ID and expected revision,
  intent, explicit changes, reason and evidence. `memory_catalog` publishes the
  actual schema, available names, strict filters and bounded resolution flow.
- Recall combines semantic and lexical candidates with bounded resolved-topic
  expansion. Omitted project filters search the personal space; explicit filters
  stay strict. Projects and systems are associations, never ownership boundaries.
- Additive migrations retain original IDs, content, timestamps and provenance.
  Positively owned legacy memories stay readable as unclassified. Unknown/foreign
  ownership is preserved outside active personal recall. No embedding-model
  switch or automatic bulk graph inference is part of this migration.
- Encrypted `.pm` keeps its existing encryption envelope. Inner archive format 2
  carries classification and revisions; bounded historical format-1 conversion
  preserves old readers without permitting legacy save/update bypasses.
- The sidebar displays **Community edition** below the existing product logo.
- Restore the **Test embeddings** action in Settings.
- Ollama and Embeddings show Starting until the configured model passes a real
  embedding probe. Memory operations return prompt retry guidance during launch;
  the existing 60-second MCP timeout is unchanged.
- Memory read, write and update indicators follow Stream MCP in the top panel.
  Their dots are grey when idle and green and blinking during activity; labels
  and badge styling stay fixed.
- Overview cards can be rearranged and resized, with automatic saved browser layouts
  and protected content widths. Live MCP activity and Corpus shape start equally split.
  Hold a card to reveal faint drop positions. Either resize edge snaps to the
  twelve-column grid while the opposite edge and neighbouring cards stay fixed;
  empty space is retained and resizing never moves cards to another row.
- Active readiness checks refresh the local model lease before idle expiry. Startup
  is counted separately from stopped services, and SQL-only Overview statistics
  remain readable while embeddings warm up.
- Installation uses exact npm versions and committed lockfiles, hash-locked Python
  packages and scanner data, and immutable container/source versions. The storage
  image builds from pinned official MinIO source for fresh installations.
- The wizard checks supported Node/npm, native shell tools, the local Linux Docker
  engine, Compose/Buildx, write access, host-port ownership, build registries and
  machine resources. The server checks again before installation. Supported
  prerequisite repairs have explicit Install/Start actions.
- Claude extraction setup explains the one-year subscription token obtained with
  `claude setup-token`, separately from Anthropic Console API billing.

This major release changes memory-tool inputs and retires sharing. Read the
[contract and migration guide](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v2.0.0/documentation/spaces/personal/knowledge-contract.md)
before upgrading. Public 1.0.0–1.3.1 installations first stop at 1.3.2; the
versioned upgrade contract then declares the bridge to 2.0.0. Preserve the full
snapshot and configuration: a source rollback is not a database rollback.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 2.0.0
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 2.0.0`.
For a new installation, follow the
[v2.0.0 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v2.0.0/README.md).

Validation includes native Codex and Claude client checks, migration and
backup/restore fixtures, revision and isolation checks, focused browser checks,
clean dependency installation and isolated Linux image builds. A complete
fresh-machine wizard installation and the full browser/device matrix were not
rerun for the final dependency update. Hosted CI is not configured.

Dependency audits report no high or critical findings. Four upstream moderate
findings remain in the MinIO JavaScript client tree and two low findings in the
documentation toolchain. See the
[dependency reproducibility guide](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v2.0.0/documentation/installation/dependency-reproducibility.md)
for supported versions and compatibility holds.

## 1.3.2 - 2026-10-24

[GitHub release v1.3.2](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.3.2)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.3.2 | Memory creation, graph navigation, retained import state and patched Next.js. |
| api | 1.0.4 | Preserve specific scanner failure diagnostics in rejected memory writes and import results. |
| worker | 1.0.1 | Use the resilient shared safety-scanner client. |
| security-dlp | 1.0.1 | Retry one transient scan failure and reject malformed scanner responses. |
| docs | 1.3.2 | Explain scanner retries, blocked rows and recovery without repeating successful imports. |
| onboarding | 1.3.1 | Refreshed wizard design with patched HTTP/static dependencies. |
| update-runner / update-flow layer / update-coordinator | 1.0.1 | Existing published-release discovery, pinned upgrades and recovery retained. |
| shared / schema | 1.1.1 | Refresh storage and Prisma dependencies; database schema retained. |
| database / mcp / mcp-runtime | 1.0.1 | Align Prisma clients and patch MCP transport/validation dependencies. |
| core-tools | 1.0.0 | Existing tool entry points retained. |
| graph / graphiti service / memory-vector / evidence-files / DLP service | 1.0.0 | Existing graph, retrieval and detector services retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

- Create memories from the dashboard, jump from details to the memory graph,
  and view live MCP sessions on Overview. The installation wizard includes
  field-level errors, step timings and a completion summary.
- Preserve import/export drafts, verified files, confirmed row progress and
  bulk-delete reviews across dashboard navigation. Import one acknowledged row
  per request and retain exact row-level errors.
- Update Next.js, HTTP parsing, MCP SDK, Prisma, schema validation and mail
  dependencies to patched releases; retain the supported Node LTS policy.
- Retry a temporary scanner timeout, network failure, HTTP 408/429 or server
  error once before rejecting a memory write. Keep the configured timeout per
  attempt and require a successful safety scan before writing.
- Preserve the scanner deadline, HTTP status, or supported network error code
  instead of collapsing every operational failure into an unavailable message.
  Diagnostics exclude submitted content, scanner response bodies and arbitrary
  exception text.
- Never retry a successful PII or secret detection automatically. Invalid or
  inconsistent scanner responses remain blocked, and explicit scanner blocks
  cannot be overridden by an empty findings list.
- Explain how to recover a skipped row after scanner recovery while retaining
  memories already imported successfully.

Direct upgrades from public 1.0.0 through 1.3.1 preserve memories, data volumes,
credentials, scanner configuration and embedding settings. This patch adds no
database migration or embedding-model change.

The production npm audit retains four moderate MinIO dependency-chain findings;
review found no current product call path to the affected APIs. See the
[scoped dependency assessment](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.3.2/documentation/spaces/personal/security.md#release-dependency-notes).

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.3.2
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.3.2`.
For a new installation, follow the
[v1.3.2 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.3.2/README.md).

## 1.3.1 - 2026-10-23

[GitHub release v1.3.1](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.3.1)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.3.1 | Preserve memory-tool state across navigation, acknowledge import progress, and show exact request errors. |
| api | 1.0.3 | Allow dashboard row imports to suppress repeated completion notifications. |
| docs | 1.3.1 | Explain import progress, interruption recovery, and browser-session state. |
| onboarding | 1.3.0 | Existing installation wizard retained. |
| update-runner / update-flow layer / update-coordinator | 1.0.1 | Existing published-release discovery, pinned upgrades and recovery retained. |
| shared / schema | 1.1.0 | Existing embedding catalog and schema retained. |
| worker / database / mcp / mcp-runtime / core-tools | 1.0.0 | Existing processing, storage and memory tools retained. |
| graph / graphiti service / memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing graph, retrieval and sensitive-data checks retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

- Keep import/export selections, selected files, verified packages, running
  progress, results, and bulk-delete reviews when switching memory tabs or visiting
  another dashboard page. State stays in browser memory for the current user and
  memory space; a full reload or sign-out clears it.
- Import one row per request and display confirmed progress instead of holding a
  single connection open while the entire file embeds. If a response is lost,
  retain confirmed results, stop submitting rows, and allow an explicit resume
  from the first unconfirmed row after its server outcome is checked.
- Show HTTP codes, schema field paths, row-level failures, and embedding/network
  timeout causes. Distinguish a rejected request from an unknown write outcome.
- Prevent conflicting mutations during an active import and duplicate bulk-delete
  confirmations after navigation. Preserve the scope and typed confirmation;
  expired previews still require a fresh server review.
- Suppress repeated browser-push notifications for dashboard row requests and
  show one aggregate completion notice. Other API imports retain their default
  completion notification.
- Align this repository's agent memory instructions with the canonical
  persistent-memory-stack project.

Direct upgrades from public 1.0.0 through 1.3.0 preserve memories, data volumes,
credentials and embedding configuration. This patch adds no database migration
or embedding-model change. Keep the browser document open during an import;
closing or reloading it stops further row submissions.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.3.1
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.3.1`.
For a new installation, follow the
[v1.3.1 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.3.1/README.md).

## 1.3.0 - 2026-09-25

[GitHub release v1.3.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.3.0)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.3.0 | Live MCP activity on Overview, memory creation from the Memories toolbar, impact-stating deletion dialogs and the completed Neural Obsidian pass. |
| onboarding | 1.3.0 | Installation wizard rebuilt to the design, with per-field errors, per-step fault states, install step timings and a completion summary. |
| docs | 1.3.0 | Documents the Overview live MCP activity panel, plus the Memories page's New memory dialog and its Open in graph jump. |
| api | 1.0.2 | Existing personal memory and provider health APIs retained. |
| update-runner / update-flow layer / update-coordinator | 1.0.1 | Existing published-release discovery, pinned upgrades and recovery retained. |
| shared / schema | 1.1.0 | Existing embedding catalog and schema retained. |
| worker / database / mcp / mcp-runtime / core-tools | 1.0.0 | Existing processing, storage and memory tools retained. |
| graph / graphiti service / memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing graph, retrieval and sensitive-data checks retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

- Watch live MCP activity from Overview. The panel lists the stream sessions that
  are connected right now with their client, connection, last-seen time and idle
  countdown. Select a session to read its live communication inside the same card,
  then return to the list. A session leaves the list as soon as it disconnects; a
  client that drops without disconnecting remains until its idle timeout. This
  replaces the previous activity panel, which could not show past memory operations.
- Overview no longer carries a manual refresh control. The page continues to
  refresh on its own every ten seconds.
- Create a memory directly from the Memories toolbar, open a record's details in a
  dialog, and jump from a record to its place in the memory graph.
- Read the exact consequences before deleting: the cascade and bulk deletion
  dialogs name what is removed and require a typed confirmation.
- Memories, Services, Workers, Token usage, Security, System Settings,
  Notifications, Documentation, sign-in, profile and the Shared Memories
  connection page complete the Neural Obsidian pass: hairline tables, rounded
  status badges, segmented controls, toned notices and consistent empty states.
- Install with a wizard that matches the design end to end: an environment
  pre-check that reads the machine one probe at a time, field-level validation,
  provider and model pickers, a highlighted environment preview that flags missing
  values, per-step install timings, and a completion summary of what is running.
- Fixes: a failed installation step no longer prints its message twice, and the
  environment pre-check no longer repeats a resources-only failure as a second
  error.

Direct upgrades from public 1.0.0 through 1.2.0 preserve memories, data volumes,
credentials and embedding configuration. This release adds no database migration
or embedding-model change.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.3.0
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.3.0`.
For a new installation, follow the
[v1.3.0 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.3.0/README.md).

Validation covers dashboard and wizard type checks and unit tests, a live review of
every dashboard page in the local stack, and a wizard walkthrough of each step and
its failure states against a mocked installer. Live MCP activity was verified with
real sessions, including a session closing while its output was open. Interface
screenshots in the documentation still show the 1.2.0 visuals, and macOS was not
retested on this Windows development machine.

## 1.2.0 - 2026-09-08

[GitHub release v1.2.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.2.0)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.2.0 | Neural Obsidian design, Obsidian and Porcelain themes, persistent appearance controls and accessible overlays. |
| onboarding | 1.2.0 | Matching wizard design, responsive layout, keyboard theme controls and dashboard appearance handoff. |
| docs | 1.2.0 | Refreshed interface screenshots and appearance guidance. |
| api | 1.0.2 | Existing personal memory and provider health APIs retained. |
| update-runner / update-flow layer / update-coordinator | 1.0.1 | Existing published-release discovery, pinned upgrades and recovery retained. |
| shared / schema | 1.1.0 | Existing embedding catalog and schema retained. |
| worker / database / mcp / mcp-runtime / core-tools | 1.0.0 | Existing processing, storage and memory tools retained. |
| graph / graphiti service / memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing graph, retrieval and sensitive-data checks retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

- Refresh the dashboard and installation wizard with the Neural Obsidian design:
  cyan-to-violet accents, clearer surface hierarchy and locally bundled fonts.
- Choose the default dark Obsidian or light Porcelain theme. The dashboard also
  follows the operating system through Match system, including after appearance
  controls close. Theme changes synchronize across open dashboard tabs.
- Carry the wizard's selected appearance into the dashboard, even when browser
  storage is unavailable. Theme controls support arrow keys, Home and End.
- Fix profile and navigation dialogs appearing behind page content. Improve
  light-theme notices, status badges, image-preview controls, graph retry controls
  and small-screen wizard layout. Keep graph legend colors aligned with nodes.
- Avoid memory-list hydration errors when Docker and the browser use different
  time zones. Redact passwords embedded in installer-preview URLs and Neo4j
  credentials without changing the saved environment.
- Fix the documentation landing redirect so its styles, images and navigation
  remain inside the dashboard's documentation route.
- Refresh public screenshots using generic demonstration data and document
  appearance controls. The personal installation wizard has eleven steps;
  optional connections remain a later dashboard action.

Direct upgrades from public 1.0.0 through 1.1.4 preserve memories, data volumes,
credentials and embedding configuration. This release adds no database migration
or embedding-model change. The graph canvas retains its dark backdrop in both themes.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.2.0
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.2.0`.
For a new installation, follow the
[v1.2.0 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.2.0/README.md).

Validation covers theme persistence, OS and browser-tab synchronization, keyboard
controls, restricted browser storage, appearance handoff, dashboard interactions
and the personal wizard flow. Physical macOS/Safari installation was not rerun
on this Windows development machine.

## 1.1.4 - 2026-09-08

[GitHub release v1.1.4](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.4)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.1.4 | Current release label and release notes. |
| onboarding | 1.1.3 | Required-runtime startup grace and visible verification diagnostics. |
| docs | 1.1.4 | Optional Ollama monitoring, verification troubleshooting and scoped dependency-image cleanup. |
| api | 1.0.2 | Monitor only required host Ollama, retain configured model names before first use and count unhealthy local models correctly. |
| update-runner / update-flow layer / update-coordinator | 1.0.1 | Existing published-release discovery, pinned upgrades and recovery retained. |
| shared / schema | 1.1.0 | Existing embedding catalog and schema retained. |
| worker / database / mcp / mcp-runtime / core-tools | 1.0.0 | Existing processing, storage and memory tools retained. |
| graph / graphiti service / memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing graph, retrieval and sensitive-data checks retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

- API-only installations no longer probe or display an unused host Ollama
  service, count it as a dashboard failure, or project a historical host error.
  Server-managed local embeddings still check the host and selected model.
  Client-managed embeddings retain their own client-scoped health.
- Show the configured Fact extraction and Embeddings model names before their
  first observed request or test. Their health remains unknown until observed.
  A reachable Ollama host with a missing required model counts as unhealthy.
- Allow up to 120 seconds for running required containers to finish their initial
  healthchecks during final verification. Image and runtime validation failures now include
  their diagnostic output instead of only a generic failure summary.
- The optional uninstall image-removal step includes exact configured downloaded
  dependencies, owned application images and explicitly listed Alpine utility
  images (`alpine:3.20` and `alpine:latest`). Preserve images referenced
  by any running or stopped container, images carrying unrelated ownership or
  extra tags, and unattributed base/cache images. Report why candidate images
  are retained; never force-remove them or run a global Docker prune.

Direct upgrades from public 1.0.0 through 1.1.3 preserve memories, data volumes,
credentials and embedding configuration. This patch adds no database migration
or embedding-model change.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.1.4
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.1.4`.
For a new installation, follow the
[v1.1.4 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.1.4/README.md).

Regression coverage exercises API-only and local-model monitoring, startup
readiness, diagnostic propagation, and image-cleanup ownership safeguards.
The original Mac verification failure cannot be attributed to Ollama from the
reported summary: its embedding check already passed, and the failing check
was required image identity/runtime validation. A physical Mac reinstall has
not been verified.

## 1.1.3 - 2026-09-08

[GitHub release v1.1.3](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.3)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.1.3 | Current release label and release notes. |
| onboarding | 1.1.2 | Safe instruction recovery, personal-only public wizard, supported Node checks and clearer setup failures. |
| docs | 1.1.3 | Node LTS selection, setup troubleshooting, instruction backups and the personal installation flow. |
| api | 1.0.1 | Existing memory APIs and published-release metadata retained. |
| update-runner / update-flow layer / update-coordinator | 1.0.1 | Existing published-release discovery, pinned upgrades and recovery retained. |
| shared / schema | 1.1.0 | Existing embedding catalog and schema retained. |
| worker / database / mcp / mcp-runtime / core-tools | 1.0.0 | Existing processing, storage and memory tools retained. |
| graph / graphiti service / memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing graph, retrieval and sensitive-data checks retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

- Recover incomplete or nested managed markers in existing Claude/Codex
  instruction files. Back up damaged originals byte-for-byte before writing,
  preserve their text outside the new managed block, and report each backup's
  location. Retries keep the recovered text and do not repeat the repair.
  Invalid custom blocks, unreadable encodings and failed backups stop safely.
- Remove Shared Memories from the public installation wizard. Review now leads
  directly to installation of the local Personal Memories stack, and hidden
  connection values cannot activate a shared connection. Existing operator
  connector flows and dashboard connections remain available separately.
- Require Node 24 LTS (24.x) or Node 22.12+ within 22.x for host installation.
  Check the running interpreter, keep macOS/Linux npm children on that same
  runtime, and explain when a successful Node installation requires restarting
  the wizard. Newer Current Node releases are not yet validated for this app.
- Name each dependency/setup substep before it runs and identify the failed
  substep without echoing private error details in the summary. This separates
  snapshot, dependency, Prisma, build and agent-registration failures.

Direct upgrades from public 1.0.0 through 1.1.2 preserve memories, data volumes,
credentials and embedding configuration. This patch adds no database migration
or embedding-model change. Use a supported Node LTS version before updating.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.1.3
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.1.3`.
For a new installation, follow the
[v1.1.3 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.1.3/README.md).

Validation covers automated host, installer, instruction-recovery and release
checks, production installer builds and Chrome wizard checks. macOS runtime
selection is covered by controlled fixtures; a physical Mac installation has
not been verified. The reported installation failure was traced to incomplete
instruction markers. Node 26 was a separate runtime-policy gap, not evidence
of Prisma incompatibility.

## 1.1.2 - 2026-09-08

[GitHub release v1.1.2](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.2)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.1.2 | Current release label and release notes. |
| onboarding | 1.1.1 | macOS available-memory estimates and clearer, sanitized OpenAI embedding-test diagnostics. |
| docs | 1.1.2 | Explains macOS memory estimates, conservative fallbacks, and OpenAI request permissions. |
| api | 1.0.1 | Existing memory APIs and published-release metadata retained. |
| update-runner / update-flow layer / update-coordinator | 1.0.1 | Existing published-release discovery, pinned upgrades and recovery retained. |
| shared / schema | 1.1.0 | Existing embedding catalog and schema retained. |
| worker / database / mcp / mcp-runtime / core-tools | 1.0.0 | Existing processing, storage and memory tools retained. |
| graph / graphiti service / memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing graph, retrieval and sensitive-data checks retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

- Fix false low-memory blocks on macOS by using an available-memory estimate
  from the free, speculative and inactive page counts reported by `vm_stat`.
  Honor its 4 KiB or 16 KiB page size and avoid adding overlapping purgeable
  pages. Preserve the raw free-memory measurement and retain all minimum
  requirements and local-model restrictions.
- Explain that inactive memory may require compression or disk writeback;
  the estimate is not a guarantee of immediately free RAM. Invalid counters,
  unavailable commands and timeouts trigger a visible, conservative fallback.
- Make OpenAI embedding-test failures actionable: distinguish request permission
  from the model allowlist, and explain authentication, model access, billing,
  IP restrictions and unsupported-region errors when the response identifies
  them. Bound response handling and display fixed safe guidance without echoing
  API keys or raw provider messages.

Direct upgrades from public 1.0.0, 1.1.0 and 1.1.1 preserve memories, data
volumes, credentials and embedding configuration. This patch adds no database
migration or embedding-model change.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.1.2
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.1.2`.
For a new installation, follow the
[v1.1.2 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.1.2/README.md).

Validation covers automated installer/resource/provider checks, production
installer builds and Chrome wizard checks with controlled responses. A physical
Mac installation and the reported account-specific OpenAI rejection have not
been verified as resolved by this patch.

## 1.1.1 - 2026-09-08

[GitHub release v1.1.1](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.1)

| Service | Version | Change |
| --- | --- | --- |
| dashboard / dashboard layer | 1.1.1 | Published-release notices, exact-version GitHub links, and matching terminal update commands. |
| api | 1.0.1 | Exposes published-release metadata and directs installation through the host coordinator. |
| update-runner / update-flow layer | 1.0.1 | Anonymous stable-release discovery and immutable tag validation; sidecar provides status rather than installing updates. |
| update-coordinator | 1.0.1 | Pins published commits for each upgrade step and preserves those pins during recovery. |
| docs | 1.1.1 | Published-release update instructions, release links, and release-note validation and extraction. |
| onboarding | 1.1.0 | Existing resource-aware installation and embedding-provider choices retained. |
| shared / schema | 1.1.0 | Existing embedding catalog and schema retained; no new database migration. |
| worker / database | 1.0.0 | Existing processing and durable storage retained. |
| mcp / mcp-runtime | 1.0.0 | Existing memory tools and stream protocol retained. |
| core-tools | 1.0.0 | Existing maintenance tools retained. |
| graph / graphiti service | 1.0.0 | Existing memory graph behavior retained. |
| memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing retrieval, evidence and sensitive-data checks retained. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local gateway and service controls retained. |

Updates now follow published stable GitHub Releases, so unreleased work on
`master` is not advertised or installed by the default update flow.

- Resolve the latest published release or an explicitly requested version to
  its exact Git tag commit, including annotated tags. Check the package version,
  public release lineage and release history at that immutable commit.
  Reject drafts, prereleases, unpublished tags and mismatched metadata.
- Keep update checks anonymous, cached and bounded, with retry backoff for
  temporary network failures and GitHub rate limits. No GitHub key is required.
- Pin every required upgrade step to a published commit. Reject changed tags
  and modified release worktrees; recovery retains the original release pins.
  Explicit `--dev` and `--branch` commands remain available for developer testing.
- Accept handoff from earlier public-release launchers only after checking
  their target version against its exact published tag commit.
- Route installation through the host coordinator and its snapshot/recovery
  flow. The dashboard sidecar provides update status and terminal guidance;
  the old direct container update path cannot bypass the coordinator.
- Link each release card and release-note entry to its exact GitHub Release.
  Validate those links during release preparation and extract the matching
  release body for publication. Include the shared source manifest and release
  resolver in the dashboard, sidecar and coordinator build artifacts they require.

Direct upgrades from public 1.0.0 and 1.1.0 preserve saved credentials,
embedding configuration, memories and data volumes. This patch adds no schema
migration or embedding-model change.

To update an existing installation, run from its repository directory:

```sh
npm run update-persistent-memory -- --release 1.1.1
```

Windows PowerShell: `npm.cmd run update-persistent-memory -- --release 1.1.1`.
For a new installation, follow the
[v1.1.1 installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.1.1/README.md).

Verification includes automated release, host/coordinator, API and dashboard
checks, production image builds, Windows deployment checks and live published
release discovery. A physical macOS update was not exercised for this patch.

## 1.1.0 - 2026-09-07

[GitHub release v1.1.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.0)

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 1.1.0 | Current release label and release notes; memory and graph interfaces retained. |
| api | 1.0.0 | Existing memory and extraction APIs use the updated shared embedding catalog. |
| worker | 1.0.0 | Existing background processing uses the updated shared embedding catalog. |
| mcp / mcp-runtime | 1.0.0 | Stream MCP and recall behavior retained. |
| database | 1.0.0 | Existing database adapter and durable storage retained. |
| shared / schema | 1.1.0 | Voyage 4 model catalog and guarded embedding configuration for empty-install retries. |
| core-tools | 1.0.0 | Existing maintenance and operator tools retained. |
| graph / graphiti service | 1.0.0 | Existing entity relationships and memory graph retrieval retained. |
| memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Existing retrieval, evidence, and sensitive-data checks retained. |
| onboarding | 1.1.0 | Resource-aware setup, remote embedding choices, provider tests, and bounded image recovery. |
| update-runner / update-coordinator | 1.0.0 | Existing snapshot and recovery flow; direct upgrade contract from public 1.0.0. |
| dashboard-gateway / docker-control | 1.0.0 | Existing local access and service management retained. |
| docs | 1.1.0 | Machine requirements, model choices, installation recovery, cleanup, and Windows graphics guidance. |

Safer installation on smaller Windows and macOS machines, with a choice of
local or API embeddings.

- Measure host RAM, currently free RAM, CPUs, installation/model disk space,
  and Docker resources. Show actual capacity beside minimum and recommended
  budgets, and block Next when a measured minimum is unmet.
- Recommend a local model only when its recommended resource budget fits.
  Otherwise suggest OpenAI `text-embedding-3-small`. Disable local embeddings
  when even the smallest supported model cannot fit; an 8 GB machine can use
  API embeddings and API extraction when the remaining base requirements pass.
- Offer OpenAI `text-embedding-3-small` and `text-embedding-3-large`, plus Voyage
  `voyage-4`, `voyage-4-large`, and `voyage-4-lite`. Test provider access and
  vector dimensions with a bounded synthetic sample before continuing.
  Voyage requires its own API key; a Claude key cannot be used for Voyage.
- Explain warnings for insufficient recommended headroom and unknown Docker
  storage measurements. Acknowledgement never overrides a measured minimum.
  Recheck resources before installation and local model tests or downloads.
- Prepare Ollama only for local embeddings, preserve its download/install
  progress, and skip local Ollama requirements for API embeddings. Keep saved
  credentials and configuration; require a new embedding test after key changes.
- Protect existing memories against accidental embedding-provider/model changes.
  Permit configuration changes on a failed first-install retry only when the
  database is proven empty. An existing corpus still requires re-embedding.
- Build images serially and check their runtime and compiled modules in isolated
  containers. Retry a failed image check once with a targeted rebuild or pull;
  stop on disk-full or storage I/O failures with recovery guidance.
- Start storage before migrations and bootstrap, then start app services.
  Verify expected image IDs, health, and restart counts before recording success.
- Clean up unused artifacts whose installation ownership can be proven. Preserve
  images referenced by any container and persistent data volumes; retain shared
  base images and build cache when ownership is unknown. Uninstall keeps its
  separate choice to preserve or explicitly remove user data.

Upgrade from public 1.0.0 preserves saved credentials, volumes, memories, and
the installed embedding configuration. Rebuilding an application image cannot
repair Docker's data disk or a damaged database. Resource budgets include
installation headroom and are estimates, not hardware performance guarantees.

Validation covers automated resource/provider/lifecycle tests, native Windows
resource detection, and isolated desktop/mobile wizard checks. Physical macOS
installation and deliberate Docker-storage corruption recovery have not been
validated for this release.

## 1.0.0 - 2026-09-06

[GitHub release v1.0.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.0.0)

| Service | Version | Change |
| --- | --- | --- |
| dashboard | 1.0.0 | Personal Memories workspace with memory lists, graph views, search, usage, and service controls. |
| api | 1.0.0 | Scoped memory access, extraction, ingestion, and dashboard APIs. |
| worker | 1.0.0 | Document processing, embeddings, and background memory maintenance. |
| mcp / mcp-runtime | 1.0.0 | Streamable HTTP tools for persistent memory and graph-first recall. |
| database / shared / schema | 1.0.0 | Durable memory storage, shared contracts, and database migrations. |
| core-tools | 1.0.0 | Shared maintenance, access checks, and operator utilities. |
| graph / graphiti service | 1.0.0 | Entity relationships, temporal facts, and memory graph retrieval. |
| memory-vector / evidence-files / security-dlp / DLP service | 1.0.0 | Semantic retrieval, source evidence, and sensitive-data checks. |
| onboarding | 1.0.0 | Guided host installation and Claude/Codex registration for Windows and macOS. |
| update-runner / update-coordinator | 1.0.0 | Public release checks and explicit updates with snapshots and recovery. |
| dashboard-gateway / docker-control | 1.0.0 | Local dashboard access, update handoff, and bounded service management. |
| docs | 1.0.0 | Installation, usage, architecture, and operator guides. |

First public release of Persistent Memory.

- Install a local Personal Memories stack on Windows or macOS, with application
  services running in Docker Linux containers. Optionally connect Shared Memories
  from the local dashboard.
- Prepare Ollama from the installation wizard, with download progress and clear
  installation, startup, and retry feedback. Choose local embeddings and test
  the extraction provider before continuing.
- Register Streamable HTTP MCP and memory rules for selected Claude and Codex
  clients, globally or for individual projects, using each platform's paths.
- Store and recall durable memories with semantic retrieval, source evidence,
  temporal relationships, scoped access, and a visual memory graph.
- Check the public GitHub master branch automatically for releases, without
  repository settings or credentials. Checks are cached and retry temporary
  failures. Installing an update remains an explicit action.
- Follow a 12-step setup wizard with consistent spacing between cards, actions,
  progress, and messages, plus responsive layouts for smaller windows.
- Enable Memory Graph by default on fresh installations and verify host services
  with HTTP checks that work with native Windows curl and macOS.
- Initialize missing embedding and extraction settings while preserving saved
  values. Keep the personal identity separate from optional Shared Memories,
  and bootstrap servers without demo teams or sample access grants; existing
  records are preserved.
