# Persistent Memory Stack

**Give your AI coding assistants a memory that lasts beyond the chat.**

Persistent Memory is a self-hosted memory system for Claude, Codex, and
MCP-compatible agents. Carry project decisions, hard-won fixes, and useful
context across conversations. Find the right knowledge again through semantic
search, explore its connections in a visual graph, and keep the source evidence
within reach.

Start with your own **Personal Memories** stack. Configure optional **Shared
Memories** connections later from the local dashboard when you have a shared
server and its connector token.

[Get started](#get-started) · [Features](#what-you-can-do) ·
[Documentation](documentation/) · [Releases](https://github.com/vshcherbukhin/persistent-memory-stack/releases) · [Release notes](release-history.md)

## What you can do

| Feature | Why it matters |
| --- | --- |
| **Remember across sessions** | Preserve project context, decisions, gotchas, and lessons so your next conversation has a useful starting point. |
| **Connect your coding assistants** | Register Streamable HTTP MCP and memory rules for Claude and Codex through the wizard. Other compatible MCP clients can use the same tool interface. |
| **Recall relevant context** | Combine semantic retrieval with graph relationships and bounded responses that retain references for deeper follow-up. |
| **Explore a living knowledge graph** | Browse memories, entities, and connections in 3D or 2D. Filter by project, tags, badges, and fact validity; follow how knowledge changes over time. |
| **Keep the evidence** | Ingest documents and retain links between sources, memories, and derived graph facts. Review graph impact before deleting a memory. |
| **Keep personal and shared work distinct** | Use Personal Memories independently, then configure an optional Shared Memories server connection with scoped access from the local dashboard. |
| **Choose models that fit your computer** | Setup checks RAM, disk space, and Docker resources. Use local Ollama embeddings or OpenAI/Voyage APIs, with suggested models and connection tests. Configure fact extraction separately. |
| **See what the system is doing** | Inspect memories, service health, worker activity, security findings, and model token usage from one dashboard. |
| **Choose a comfortable appearance** | Use the default Obsidian dark theme, Porcelain light theme, or Match system in the dashboard. Change appearance from your profile without changing anyone else's account settings. |
| **Avoid unnecessary model work** | Unchanged memory updates skip extraction, embedding, and graph processing; meaningful edits keep the full pipeline. |
| **Maintain memory with control** | Background workers handle processing and maintenance. Sensitive-data checks and access controls protect the memory flow; explicit updates take snapshots before rebuilding. |

Your memory services and databases run in Docker Linux containers. Native host
tooling handles installation, Ollama, and agent configuration on Windows and
macOS. Extraction uses the provider you configure; running the stack locally
does not require every model to run locally.

The dashboard and installer bundle their fonts locally, so their appearance does
not depend on a font CDN. Cloud model requests, downloads and update checks still
require network access. The memory graph keeps a dark canvas in both themes to
make its nodes and connections legible; surrounding controls follow your theme.
See [appearance and profile settings](documentation/spaces/personal/profile.md#appearance).

## Get started

Prepare **Node.js 24 LTS** (or Node 22.12+ within the Node 22 line), **Git**, and
**Docker Desktop running Linux containers**. Windows also needs **Git for Windows
with Git Bash**. The wizard can install or start Ollama and guide model setup.
The supported host runtime is **Node 22.12+ within major 22 or Node 24.x**;
other majors, including Node 25 and 26, are not supported by this installer.
For macOS runtime selection and early setup failures, see
[Node recovery instructions](documentation/installation/installation-steps.md#macos-recover-from-an-early-setup-failure).

### Machine requirements

These are conservative **installation budgets for the whole application**, not
model-vendor minimums or measured performance guarantees. All rows use API fact
extraction. Values are GiB; disk figures mean **free space before installation**.

| Embeddings | Host RAM minimum / recommended | Host memory headroom minimum / recommended | Free installation disk minimum / recommended¹ |
| --- | --- | --- | --- |
| **OpenAI or Voyage API** — lowest local resource needs | **8 / 16** | **2 / 4** | **35 / 60** |
| Ollama `nomic-embed-text` | 12 / 16 | 3 / 5 | 37 / 64 |
| Ollama `qwen3-embedding:0.6b` | 16 / 24 | 4 / 6 | 39 / 66 |
| Ollama `qwen3-embedding:4b` | 24 / 32 | 6 / 10 | 43 / 72 |
| Ollama `qwen3-embedding:8b` | 48 / 64 | 12 / 16 | 51 / 84 |

Every choice also needs **2 / 4 logical CPUs**, **4 / 6 GiB assigned to Docker**,
and **25 / 40 GiB free inside Docker's Linux storage** (minimum / recommended).
¹ The table combines application and Ollama space on the same physical disk.
Separate model or Docker disks are checked separately. Leave additional room
for a growing memory database, documents, backups, and OS updates.

Host memory headroom means currently free RAM on Windows and estimated available
RAM on macOS. The same minimum budgets apply to both platforms.

**On computers with 8 GiB RAM, use API embeddings and API fact extraction.** Setup
disables local models below their minimum, and blocks installation if even the
API configuration cannot meet the minimum. Close other memory-heavy apps and
free disk space before rechecking. Unknown Docker storage measurements are
identified explicitly and require checking Docker Desktop before continuing.

OpenAI `text-embedding-3-small` is the API default for value;
`text-embedding-3-large` offers higher retrieval quality at higher cost and
vector storage. Voyage offers `voyage-4` for balance, `voyage-4-large` for quality,
and `voyage-4-lite` for lower latency/cost. Anthropic does not supply a Claude
embedding model: Voyage needs a **separate Voyage API key**. Remote embedding
requests send memory/search text to the selected provider; the database remains
local. See [requirements and model choices](documentation/installation/machine-requirements.md)
for the selection policy and official provider guidance.

Windows users: follow the [Windows preparation guide](documentation/installation/windows-installation.md)
for Docker/WSL prerequisites and native Windows installation details.

**Windows graphics tip:** If Memory Graph zooming or rotation feels slow on a
laptop with integrated and NVIDIA/AMD graphics, check which GPU your browser
uses. Windows can assign Chrome to integrated graphics even when a discrete GPU
is available. See [browser GPU setup and verification](documentation/installation/windows-installation.md#memory-graph-graphics-performance).

Clone the project:

```bash
git clone --config core.autocrlf=false https://github.com/vshcherbukhin/persistent-memory-stack.git
cd persistent-memory-stack
```

Launch the guided installer on **macOS**:

```bash
npm run install-persistent-memory
```

Or from **Windows PowerShell**:

```powershell
npm.cmd run install-persistent-memory
```

The 11-step personal-install wizard checks prerequisites, prepares models, tests your extraction
provider, builds the stack, and registers your selected Claude/Codex clients.
Have your extraction API key and, for API embeddings, an embedding API key ready
(the same OpenAI key can serve both). Keep the installer terminal
open until it finishes. Shared-server connections are configured later from the
dashboard, after personal installation is complete.

Then open the dashboard at **[localhost:3200](http://localhost:3200)** and reconnect
your agent client so it loads the MCP configuration and memory rules. A fresh
installation starts with an empty memory graph, ready for your own work.

See the [installation walkthrough](documentation/installation/installation-steps.md)
and [Personal Memories guide](documentation/spaces/personal/index.md) for the next steps.

## Everyday commands

Run these from your checkout. In Windows PowerShell, use `npm.cmd` in place of
`npm` if the PowerShell npm wrapper is blocked by execution policy.

```bash
npm run start-persistent-memory
npm run stop-persistent-memory

# Install the latest published stable release through the snapshot-protected updater
npm run update-persistent-memory

# Open the product and operator documentation
npm run docs:serve
```

Published stable GitHub Releases are checked automatically without GitHub
credentials or source settings. A commit on `master` alone is not an update.
Installing an update is an explicit action; the updater validates the release's
exact tagged commit before building it. Existing memories,
credentials, and Docker volumes are user data; follow the
[operations guide](documentation/stack-architecture/operations.md) for maintenance
and recovery.

For removal, use `npm run uninstall-persistent-memory` and review its export and
data-removal choices. See the [uninstall guide](documentation/installation/uninstall-memory-stack.md).

## Documentation

- [Installation and setup](documentation/installation/installation-steps.md)
- [Personal Memories dashboard](documentation/spaces/personal/index.md)
- [Architecture](documentation/stack-architecture/architecture.md)
- [Security and access boundaries](documentation/stack-architecture/security.md)
- [Operations and recovery](documentation/stack-architecture/operations.md)
- [Release history](release-history.md)

The full product, dashboard, architecture, and operator documentation lives in
[`documentation/`](documentation/).

## Development and verification

Live integration tests use a separately namespaced server-mode DEV stack with
their own containers, images, volumes, network, ports, and bootstrap token.
They do not target your Personal or Shared Memories installation.

```bash
npm run dev-test:up
# Add a scoped extraction-provider key to .local/dev-test-stack/.env
npm run dev-test:run
npm run dev-test:down
```

The runner rejects an API without the disposable `testStack:true` marker.
See the [integration test guide](test/integration/README.md) and
[benchmark methodology](documentation/stack-architecture/benchmarking.md).
Release measurements are published only after evidence is collected for that
release.

The public update source is defined once in
`layers/update-ops/update-flow/public-source.json`. Deployment-specific
identifiers stay out of shipping UI placeholders, tool schemas, and fixtures.
`npm run test:deployment-agnosticism` checks tracked filenames and text against
the project denylist and runs as part of `npm test`.
