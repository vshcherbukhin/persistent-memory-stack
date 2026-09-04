#!/usr/bin/env sh
# =============================================================================
# persistent-memory-mcp.sh — legacy local command launcher (no Docker).
#
# New installs use the stream MCP service. This launcher is retained only so
# older registrations fail clearly or can be migrated by setup/update helpers.
#
# stdout is RESERVED for JSON-RPC frames — every diagnostic here goes to stderr.
# The MCP reads PM_USER_TOKEN / API_URL / OLLAMA_URL from the environment (the
# `~/.claude.json` mcpServers `env` block sets them); we only fill defaults.
# PM_USER_TOKEN is optional until the MCP calls /config: full-local installs omit
# it, while server deployments fail fast in apps/mcp/src/config.ts after /config.
# =============================================================================
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"

# Defaults for a local single-machine setup (override via the mcpServers env block).
: "${API_URL:=http://localhost:8090}"
: "${OLLAMA_URL:=http://localhost:11434}"
export API_URL OLLAMA_URL
if [ "${PM_USER_TOKEN+x}" = x ]; then
  export PM_USER_TOKEN
fi

if [ ! -f "$HERE/dist/index.js" ]; then
  echo "persistent-memory-mcp: build missing — run 'npm run -w persistent-memory-mcp build' first." >&2
  exit 1
fi

exec node "$HERE/dist/index.js"
