# Persistent Memory Stack

**Give your AI coding assistants a memory that lasts beyond the chat.**

Persistent Memory is a self-hosted memory system for Claude, Codex, and
MCP-compatible agents. Carry project decisions, hard-won fixes, and useful
context across conversations. Find the right knowledge again through semantic
search, explore its connections in a visual graph, and keep the source evidence
within reach.

Start with your own **Personal Memories** stack. Connect **Shared Memories**
later when you want access to a team's knowledge.

[Get started](#get-started) · [Features](#what-you-can-do) ·
[Documentation](documentation/) · [Release notes](release-history.md)

## What you can do

| Feature | Why it matters |
| --- | --- |
| **Remember across sessions** | Preserve project context, decisions, gotchas, and lessons so your next conversation has a useful starting point. |
| **Connect your coding assistants** | Register Streamable HTTP MCP and memory rules for Claude and Codex through the wizard. Other compatible MCP clients can use the same tool interface. |
| **Recall relevant context** | Combine semantic retrieval with graph relationships and bounded responses that retain references for deeper follow-up. |
| **Explore a living knowledge graph** | Browse memories, entities, and connections in 3D or 2D. Filter by project, tags, badges, and fact validity; follow how knowledge changes over time. |
| **Keep the evidence** | Ingest documents and retain links between sources, memories, and derived graph facts. Review graph impact before deleting a memory. |
| **Keep personal and shared work distinct** | Use Personal Memories independently, then optionally connect a Shared Memories server with scoped access. |
| **Choose your models** | Run embeddings through Ollama and configure your extraction provider and model. Test the provider connection during setup and manage settings from the dashboard. |
| **See what the system is doing** | Inspect memories, service health, worker activity, security findings, and model token usage from one dashboard. |
| **Avoid unnecessary model work** | Unchanged memory updates skip extraction, embedding, and graph processing; meaningful edits keep the full pipeline. |
| **Maintain memory with control** | Background workers handle processing and maintenance. Sensitive-data checks and access controls protect the memory flow; explicit updates take snapshots before rebuilding. |

Your memory services and databases run in Docker Linux containers. Native host
tooling handles installation, Ollama, and agent configuration on Windows and
macOS. Extraction uses the provider you configure; running the stack locally
does not require every model to run locally.

## Get started

Prepare **Node.js 24 LTS** (or Node 22.12+ within the Node 22 line), **Git**, and
**Docker Desktop running Linux containers**. Windows also needs **Git for Windows
with Git Bash**. The wizard can install or start Ollama and guide model setup.

Windows users: follow the [Windows preparation guide](documentation/installation/windows-installation.md)
for Docker/WSL prerequisites and native Windows installation details.

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

The 12-step wizard checks prerequisites, prepares models, tests your extraction
provider, builds the stack, and registers your selected Claude/Codex clients.
Have your chosen extraction provider's API key ready. Keep the installer terminal
open until it finishes.

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

# Install the latest public release through the snapshot-protected updater
npm run update-persistent-memory -- --branch master

# Open the product and operator documentation
npm run docs:serve
```

Public release checks run automatically without GitHub credentials or source
settings. Installing an update is an explicit action. Existing memories,
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
