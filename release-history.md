# Release History

<!-- persistent-memory-release-line: public-v1 -->

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
