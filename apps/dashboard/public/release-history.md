# Release History

<!-- persistent-memory-release-line: public-v1 -->

## 1.1.0 - 2026-09-07

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
