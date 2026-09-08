# Release History

<!-- persistent-memory-release-line: public-v1 -->

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
