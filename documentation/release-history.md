---
nav_hidden: true
---
# Documentation Release History

## 2.0.0 - 2026-10-27

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
- Ollama and Embeddings show Starting until the configured model passes a real
  embedding probe. Memory operations return prompt retry guidance during launch;
  the existing 60-second MCP timeout is unchanged.
- Memory read, write and update indicators follow Stream MCP in the top panel.
  Only their dots blink for activity; labels and badge styling stay fixed.
- Overview cards can be rearranged and resized, with automatic saved browser layouts
  and protected content widths. Live MCP activity and Corpus shape start equally split.
  Hold a card to reveal faint drop positions; resize from its highlighted right edge.
- Active readiness checks refresh the local model lease before idle expiry. Startup
  is counted separately from stopped services, and SQL-only Overview statistics
  remain readable while embeddings warm up.

This major release changes memory-tool inputs and retires sharing. Read the
[contract and migration guide](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v2.0.0/documentation/spaces/personal/knowledge-contract.md)
before upgrading. Public 1.0.0–1.3.1 installations first stop at 1.3.2; the
versioned upgrade contract then declares the bridge to 2.0.0. Preserve the full
snapshot and configuration: a source rollback is not a database rollback.

## 1.3.2 - 2026-10-24

[GitHub release v1.3.2](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.3.2)

- Refresh patched dashboard, installer, transport, validation and storage dependencies.
- Explain one bounded retry for temporary scanner failures, specific scanner
  diagnostics, and recovery of skipped import rows without repeating successful rows.
- Clarify that detected PII/secrets and malformed scanner responses remain blocked.
- Preserve the configured per-attempt scan timeout and existing memory, storage
  and embedding configuration; no database migration is introduced.

## 1.3.1 - 2026-10-23

[GitHub release v1.3.1](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.3.1)

- Document retained import/export and bulk-delete state across dashboard navigation,
  including the full-reload/sign-out boundary for browser-memory drafts.
- Explain per-row import acknowledgements, confirmed progress, exact request errors,
  and checking an unconfirmed row before resuming an interrupted import.
- Keep the existing installation wizard and graph guidance. This patch requires no
  database migration or embedding-model change.

## 1.3.0 - 2026-09-25

[GitHub release v1.3.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.3.0)

- Documents the Overview live MCP activity panel: the connected stream sessions,
  their idle countdown, the live output of a selected session, and when a session
  leaves the list.
- Describes the corpus shape panel beside it.
- Documents the Memories page's **New memory** dialog, including every field the
  Shape gate requires, and the **Open in graph** jump from a record to its node.
- Includes version-specific
  [installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.3.0/README.md)
  and the `npm run update-persistent-memory -- --release 1.3.0` update command.
- Interface screenshots still show the 1.2.0 visuals; the dashboard and wizard
  captures have not been rerun for this release.

## 1.2.0 - 2026-09-08

[GitHub release v1.2.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.2.0)

- Introduces Obsidian, Porcelain and Match system appearance guidance, profile
  and settings controls, local fonts and the deliberately dark Memory Graph canvas.
- Refreshes dashboard and eleven-step personal installation screenshots using
  isolated demonstration data. Optional shared connections remain a later
  dashboard action.
- Explains the wizard-to-dashboard appearance handoff and browser-local preferences.
  Installer review masks embedded database URL credentials as well as secret fields.
- Corrects the `/docs` landing redirect to keep relative assets and navigation
  under `/docs/index.html`.
- Includes version-specific
  [installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.2.0/README.md)
  and the `npm run update-persistent-memory -- --release 1.2.0` update command.

## 1.1.4 - 2026-09-08

[GitHub release v1.1.4](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.4)

- Explains that API-only installs omit host Ollama monitoring, while required
  server-managed local embeddings still report missing hosts and models.
  Configured capability models remain visible before their first observation.
- Documents the 120-second grace for running containers' initial healthchecks and
  visible image/runtime diagnostics. The reported Mac failure occurred in required image/runtime
  validation; its exact cause remains unverified.
- Describes optional uninstall cleanup of exact configured dependency images,
  the explicitly listed Alpine utility tags `alpine:3.20` and `alpine:latest`,
  protection for running/stopped containers and unrelated ownership/tags, and
  retention of unattributed base images and caches without forced removal.
- Includes version-specific
  [installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.1.4/README.md)
  and the `npm run update-persistent-memory -- --release 1.1.4` update command.

## 1.1.3 - 2026-09-08

[GitHub release v1.1.3](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.3)

- Documents Node 24 LTS or Node 22.12+ within 22.x, Homebrew selection and the
  need to restart setup after changing the running interpreter. Newer Current
  Node releases are not yet validated for this application.
- Explains the named setup substeps and how to find the underlying command
  error without treating a wrapper failure as a proven Prisma incompatibility.
- Describes automatic recovery of damaged memory-instruction markers, original
  backups, retained user text and conditions that still stop writes safely.
- Updates the public wizard to install Personal Memories directly after review;
  optional Shared Memories connections remain a separate dashboard operation.
- Distinguishes automated and browser verification from an unverified physical
  Mac installation. Includes version-specific
  [installation instructions](https://github.com/vshcherbukhin/persistent-memory-stack/blob/v1.1.3/README.md)
  and the `npm run update-persistent-memory -- --release 1.1.3` update command.

## 1.1.2 - 2026-09-08

[GitHub release v1.1.2](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.2)

- Explains estimated available memory on macOS, its raw free-memory reading,
  inactive-page caveats and conservative fallback when measurement fails.
  Existing minimum requirements and local-model restrictions remain in force.
- Clarifies OpenAI embedding request permissions versus project model allowlists,
  with guidance for authentication, model access, billing and network restrictions.
  Provider diagnostics remain bounded and never expose raw error messages or keys.
- Documents that automated and browser checks do not establish a successful
  installation on the affected Mac or resolution of an account-specific rejection.

## 1.1.1 - 2026-09-08

[GitHub release v1.1.1](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.1)

- Explains anonymous checks of published stable GitHub Releases, exact tagged
  commits, and explicit developer branch commands.
- Documents pinned upgrade steps, recovery and host-coordinator installation;
  earlier launchers require published target verification, while the dashboard
  sidecar provides status and terminal guidance.
- Adds exact-version GitHub links to release histories and documents the
  release-note validator and publication-body extraction command.

## 1.1.0 - 2026-09-07

[GitHub release v1.1.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.1.0)

- Adds a minimum/recommended resource table for API embeddings and each local
  model, including the supported API path for 8 GB machines.
- Explains automatic model recommendations, resource checks, blocking errors,
  provider connection tests, and independent embedding/extraction credentials.
- Documents OpenAI and Voyage embedding choices, local-model memory risks,
  interrupted-install recovery, and cleanup that preserves existing user data.
- Adds Windows browser graphics guidance for smoother memory-graph interaction.
- Explains GitHub source releases, optional package registries, and the existing
  public-master update feed.

## 1.0.0 - 2026-09-06

[GitHub release v1.0.0](https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v1.0.0)

- First public documentation for Persistent Memory on Windows and macOS.
- Covers the 12-step personal installation wizard, Ollama setup, provider tests,
  and platform-aware Claude/Codex MCP and memory-rule registration.
- Documents automatic public GitHub release checks and explicit updates with
  snapshots, progress reporting, and recovery.
- Includes Personal and Shared Memories guides, architecture, security,
  maintenance, and benchmark methodology. Release measurements are published
  only after they are collected for that release.
