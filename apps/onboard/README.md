# onboard — one-command onboarding installer

A **host-only**, single-use web wizard that installs the local Personal Memories
stack and stream MCP service. Launch it with one command from the repo root:

```bash
npm run install-persistent-memory   # opens http://127.0.0.1:4319
```

The installer auto-detects the environment, generates every env var
(auto-generating the secrets you should not invent), runs the install with live
progress, registers the stream MCP into your agent app(s), writes the detailed
memory-usage rule, writes the top memory block into CLAUDE.md / AGENTS.md, and
hands off to the local dashboard.

## Install Model

There is one client install:

1. Install the local **Personal Memories** stack first.
2. Configure local embeddings, extraction LLM, dashboard account, and stream MCP.
3. Optionally connect **Shared Memories** after personal setup by testing a
   server-issued connector token against remote `/config` and `/whoami`.

Legacy `full`, `engine`, and `mcp` flow ids remain as migration aliases in tests
and payload normalization. The visible wizard normalizes them to the personal-first
flow.

## What It Does

- **Environment pre-check** — shows fixed Node, Docker, Docker Compose, and
  Ollama cards. Each card moves from pending/verifying to either a green success
  or a yellow warning with the relevant install/start action. Homebrew is manual
  because the official installer can require Administrator approval; after the
  user installs Homebrew, returning to this step runs the checks again.
- **Account** — collects the local dashboard email/name and optional password.
  The local dashboard user has full local rights; Shared Memories permissions
  come later from the remote connector token.
- **Embeddings** — picks the local personal memory model/dim. This also becomes
  the compatibility baseline for client-managed Shared Memories connections.
- **Extraction LLM** — provider + model + API key for Shape gate and graph
  extraction. The step calls the selected provider with a small probe; Next stays
  disabled until the fact extraction test passes.
- **Ecosystem** — checkboxes for detected agent apps (Claude CLI/Desktop and
  separate Codex CLI/Desktop choices).
- **Registration** — global vs project scope plus the stream MCP service. Agent
  config entries carry only `http://127.0.0.1:8091/mcp`; connector tokens stay in
  the local dashboard/API.
- **Rule** — review/edit the top memory block written into CLAUDE.md / AGENTS.md
  plus the detailed `persistent-memory.md` rule prompt. The generated rule tells
  agents to choose Personal Memories or Shared Memories at the start of each new
  project when both surfaces are configured, park the choice under project-level
  `.claude`/`.codex` config when possible, and default non-project sessions to
  personal `project: "general"`.
- **Review** — writes `.env.persistent-memory` with `DEPLOYMENT_MODE=local`,
  local embedding settings, stream MCP settings, and masked secrets.
- **Shared Memories** — optional. Collects Shared API URL + connector token, calls
  remote `/config` and `/whoami`, compares embedding topology/model/dim, and saves
  the connection only after the local personal stack is installed and verified.
- **Install** — runs the personal stack commands (`ollama pull` if needed,
  `compose up` with `COMPOSE_PROFILES=mcp-stream`, migrate, container-applied
  `rls.sql`, seed, restart, verify), then registers stream MCP and writes rules.

## Shared Memories Compatibility

The connection step accepts one shared server per local personal stack.

- **server-managed embeddings:** no local shared embedding model is required; the
  shared server embeds.
- **client-managed embeddings:** the local selected model/dim must match the
  shared server pin. If the provider/model/dim is incompatible, the wizard blocks
  with the exact model/dim to install or select.

The connector token is server-issued, role/team-scoped, shown once by the server,
stored locally as a masked secret, and used by the local dashboard/API/MCP as a
connector credential. It is not a human dashboard login session.

## Architecture

- **Standalone** package (not a `@pm/*` workspace member, like `apps/dashboard/`). It runs
  before the stack exists, so it has no built-workspace dependencies.
- **Backend** — Fastify on `127.0.0.1` only (`server/*.ts`, compiled with `tsc`
  and run from `dist/`). Spawns install commands with argv arrays (no shell); register/write-rule
  run in-process as `fn` steps. Pure logic (`env`, `prereq`, `steps`, `detect`,
  `register`, `rule`) is unit-tested in `test/`.
- **Config writers** are idempotent, preserve sibling MCP servers, splice only
  the persistent-memory Codex table, and write private `0o600` files.
- **Agent update helper** (`server/agent-update.ts`, compiled before execution) reuses the same writers for
  `npm run update-persistent-memory`, refreshing only detected persistent-memory
  Claude/Codex artifacts with the current rule template and upgrading legacy
  command-based entries to the stream URL. The final update step recompiles and
  validates its complete ignored `dist/` bundle before running, so a stale or
  interrupted older installation cannot leave an orphaned entry point behind.
- **Uninstall helper** (`../../deploy/scripts/uninstall.sh`) follows the same env-file and
  data-safety rules: it checks for memory rows, offers JSON or encrypted `.pm`
  export in the repo root, then removes Compose containers, networks, stack
  volumes, images, leftover `persistent-memory-*` tags, and the generated
  `.env.persistent-memory`.
- **RLS helper** applies `layers/core/schema/rls.sql` through the running Postgres container,
  so users do not need a host `psql`.
- **Lifecycle scripts** read `.env.persistent-memory` with a literal parser
  instead of sourcing it as shell code, so API keys/passwords containing shell
  metacharacters are safe.
- **Frontend** — React + Vite SPA (`web/`), built to `web/dist` and served by the
  backend at the same origin.

## Security / Boundaries

It intentionally runs privileged install commands on **your** machine. It binds
loopback only, is single-use + self-terminating, and an idle tab self-exits after
30 minutes. **Never containerize it or ship it to the server**; it is excluded
from images and gitignored build output.

## Develop / Test

```bash
cd apps/onboard
npm install
npm run dev        # Vite dev server (proxies /api to :4319)
npm run typecheck
npm test           # pure-logic unit tests
```
