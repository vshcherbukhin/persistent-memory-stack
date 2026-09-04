#!/usr/bin/env sh
# =============================================================================
# persistent-memory-docker-mcp.sh — legacy Docker stdio launcher.
#
# New installs use the stream MCP service. This wrapper is retained for old
# Docker-stdio sessions so stale containers can still be identified, logged, and
# terminated.
# =============================================================================
set -eu

: "${API_URL:=http://host.docker.internal:8090}"
: "${OLLAMA_URL:=http://host.docker.internal:11434}"

raw_client="${PM_MCP_CLIENT_NAME:-client}"
client="$(printf '%s' "$raw_client" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_.-' '-')"
case "$client" in
  ''|[-.]*)
    client="client${client}"
    ;;
esac

instance="${PM_MCP_INSTANCE_ID:-$$}"
image="${PM_MCP_IMAGE:-persistent-memory-mcp:latest}"
container_name="persistent-memory-${client}-mcp-${instance}"
service_name="${client}-mcp"

if [ "${PM_USER_TOKEN+x}" = x ] && [ -n "${PM_USER_TOKEN}" ]; then
  exec docker run -i --rm \
    --name "$container_name" \
    --label "com.docker.compose.project=persistent-memory" \
    --label "com.docker.compose.service=$service_name" \
    --label "persistent-memory.role=mcp-client" \
    --label "persistent-memory.client=$client" \
    --label "persistent-memory.transport=stdio" \
    -e PM_USER_TOKEN \
    -e API_URL \
    -e OLLAMA_URL \
    --add-host=host.docker.internal:host-gateway \
    "$image"
fi

exec docker run -i --rm \
  --name "$container_name" \
  --label "com.docker.compose.project=persistent-memory" \
  --label "com.docker.compose.service=$service_name" \
  --label "persistent-memory.role=mcp-client" \
  --label "persistent-memory.client=$client" \
  --label "persistent-memory.transport=stdio" \
  -e API_URL \
  -e OLLAMA_URL \
  --add-host=host.docker.internal:host-gateway \
  "$image"
