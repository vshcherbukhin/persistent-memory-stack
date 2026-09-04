# Registering `persistent-memory-mcp` with Claude Code & Claude Desktop

`persistent-memory-mcp` maps tools to the API and does **no** auth/RLS itself.
The API remains the single authorization choke-point. Local personal installs
report `deploymentMode: local` from `/config`, so no token is needed for Personal
Memories. Shared Memories use the connector token saved by the local dashboard.

The supported runtime is the **stream MCP service**:

- One Docker-managed `persistent-memory-mcp` Compose service serves Streamable
  HTTP at `http://localhost:8091/mcp`.
- Claude Code, Claude Desktop folder sessions, Codex CLI, and Codex Desktop
  register against that local HTTP endpoint.
- The local dashboard stores and rotates any Shared Memories connector token.
  Agent config files carry only the local MCP URL.
- Legacy command-based registrations are migration aliases only. Updates rewrite
  persistent-memory entries to the stream service.

The onboarding wizard writes the entries for you. This file documents the shape
when you need to inspect or repair them by hand.

## Claude Code / Claude Desktop Folder Sessions

Use `~/.claude.json`, either at the top level or under
`projects.{projectPath}.mcpServers`:

```jsonc
{
  "mcpServers": {
    "persistent-memory": {
      "type": "http",
      "url": "http://127.0.0.1:8091/mcp"
    }
  }
}
```

Only `recall_context` is marked as the always-available task-start tool. All
other Persistent Memory tools are deferred until the agent needs them, avoiding
the context cost of loading every write, graph, document, and admin schema into
each Claude session.

Do **not** write this HTTP entry to
`~/Library/Application Support/Claude/claude_desktop_config.json`; that file is
for standalone Desktop local command servers. Standalone Claude Desktop chat
should use a Claude Custom Connector for the stream URL.

## Codex CLI / Codex Desktop

Use `~/.codex/config.toml` for global registration, or
`<project>/.codex/config.toml` for project-scoped registration:

```toml
[mcp_servers.persistent-memory]
type = "http"
url = "http://127.0.0.1:8091/mcp"
```

Project-scoped Codex registration still requires the folder to be trusted in
Codex.

## Personal And Shared Memories

The stream MCP service reads surface configuration from the local stack:

- **Personal Memories** route to the local personal stack.
- **Shared Memories** route to the configured shared server through the masked
  connector token stored by the local dashboard.
- Project conversations ask once for Personal or Shared only when both are
  configured. A Personal-only MCP exposes no Shared choice and routes all
  projects to Personal Memories.
- Non-project conversations default to Personal Memories.

After saving, rotating, or disconnecting Shared Memories in the dashboard,
restart the stream MCP service from Services or rerun the installer/update helper.

## Server-Managed Vs Client-Managed Embeddings

The embedding topology is read from the selected surface's `GET /config`:

- **server-managed embeddings:** the API/worker embed on the server; the MCP sends
  text only.
- **client-managed embeddings:** the MCP embeds locally with the server-pinned
  model and dimension and sends the precomputed vector.

The MCP never trusts an `EMBEDDING_MODE` value from agent config. If the shared
server requires a client-managed model that the local host does not have, the
dashboard connection flow blocks with the exact model/dim to install.

## Verify

```sh
claude mcp list
```

Then ask the agent to call `whoami`. It should return the local Personal
Memories identity by default, and Shared Memories should reflect the server role
granted by the connector token.
