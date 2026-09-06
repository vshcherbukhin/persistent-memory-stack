#!/bin/bash
# Start the Persistent-Memory Stack (SERVER) — idempotent.
# If all expected server services are already running, prints a skip
# message and exits 0 instead of re-issuing `docker compose up -d`
# (which is idempotent but produces noisy "Container ... Running" output
# that teammates have mistaken for a "step 2" they need to perform).
#
# Scope: this starts the SERVER stack (deploy/compose/docker-compose.yml). The only supported
# MCP runtime is the shared Streamable HTTP service, enabled by the mcp-stream
# Compose profile for local personal stacks.

set -e

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
start.sh — Start the Persistent-Memory Stack (SERVER)

USAGE
  deploy/scripts/start.sh
  deploy/scripts/start.sh --help | -h

WHAT IT DOES
  - Verifies the HOST Ollama daemon is reachable on $OLLAMA_URL (default
    http://host.docker.internal:11434, probed from the host as
    http://localhost:11434). Starts it via `brew services start ollama`
    if not running.
  - Verifies the configured $EMBED_MODEL is pulled in Ollama (warns with
    the `ollama pull` command if missing — embeddings will fail without it).
  - Runs `docker compose up -d` for the SERVER stack:
      persistent-memory-qdrant, persistent-memory-falkordb,
      persistent-memory-postgres, persistent-memory-redis,
      persistent-memory-minio, persistent-memory-graphiti,
      persistent-memory-api, persistent-memory-worker,
      persistent-memory-dashboard, persistent-memory-documentation,
      persistent-memory-dashboard-gateway
    plus persistent-memory-mcp when PM_MCP_RUNTIME=stream.
    (persistent-memory-neo4j is OFF by default — it lives behind the
     "neo4j" compose profile; start it with --profile neo4j explicitly.)
  - Prints the URLs for the dashboard, documentation, and service UIs/endpoints.

IDEMPOTENT
  If every default server service is already running, prints
    "=== Persistent-Memory Stack already running — skip ==="
  and exits 0 without touching docker. Safe to run on an already-up stack.

URLS PRINTED ON FRESH START
  Dashboard:          http://localhost:3200
  Documentation:      http://localhost:3200/docs/index.html
  API:                http://localhost:8090
  Qdrant UI:          http://localhost:7333/dashboard
  Graphiti API docs:  http://localhost:8100/docs
  FalkorDB Browser:   http://localhost:3100
  MinIO Console:      http://localhost:9003   (S3 API on http://localhost:9002)
  Service credentials: dashboard Services page credentials modal
                       (Qdrant/FalkorDB/MinIO/Neo4j; admin/super-admin only)

DATA PERSISTENCE
  Data is stored in Docker named volumes (persistent_memory_qdrant_data,
  persistent_memory_falkordb_data, persistent_memory_postgres_data,
  persistent_memory_redis_data, persistent_memory_minio_data, and
  — when the neo4j profile is used — persistent_memory_neo4j_data).
  `deploy/scripts/stop.sh` preserves these.
HELP
    exit 0
fi

# This script lives in deploy/scripts/; operate on the repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/host-platform.sh"
SCRIPT_DIR="$(pm_host_path "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pm_host_pwd)"
cd "$REPO_ROOT"
mkdir -p .local/update-state
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.yml"

# shellcheck source=deploy/scripts/lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"

# ---------------------------------------------------------------------------
# Load .env (for OLLAMA_URL / EMBED_MODEL) if present. Compose also receives this
# file via `--env-file` so ${VAR:-default} interpolation in deploy/compose/docker-compose.yml uses
# the same runtime values as `env_file:`. Do not run raw `docker compose up` here:
# Compose does not use env_file values for interpolation.
# ---------------------------------------------------------------------------
ENV_FILE=".env.persistent-memory"
if [ -f "$ENV_FILE" ]; then
    if [ -f ".env.persistent-memory.example" ]; then
        pm_env_backfill_missing_from_template "$ENV_FILE" ".env.persistent-memory.example"
    fi
    if pm_env_ensure_generated_secret TOKEN_PEPPER "$ENV_FILE" 43; then
        echo "Generated TOKEN_PEPPER in $ENV_FILE (token-hash pepper)."
    fi
    if pm_env_ensure_generated_secret POSTGRES_PASSWORD "$ENV_FILE" 36; then
        echo "Generated POSTGRES_PASSWORD in $ENV_FILE (database owner role)."
    fi
    if pm_env_ensure_generated_secret PM_APP_PASSWORD "$ENV_FILE" 36; then
        echo "Generated PM_APP_PASSWORD in $ENV_FILE (RLS runtime role)."
    fi
    if pm_env_ensure_generated_secret MINIO_ROOT_PASSWORD "$ENV_FILE" 36; then
        echo "Generated MINIO_ROOT_PASSWORD in $ENV_FILE (evidence/object store)."
    fi
    if pm_env_ensure_generated_secret FALKORDB_PASSWORD "$ENV_FILE" 36; then
        echo "Generated FALKORDB_PASSWORD in $ENV_FILE (FalkorDB Browser/Redis auth)."
    fi
    if pm_env_ensure_generated_secret QDRANT_API_KEY "$ENV_FILE" 40; then
        echo "Generated QDRANT_API_KEY in $ENV_FILE (Qdrant API/dashboard auth)."
    fi
    if pm_env_ensure_generated_secret UPDATE_RUNNER_TOKEN "$ENV_FILE" 32; then
        echo "Generated UPDATE_RUNNER_TOKEN in $ENV_FILE (dashboard update auth)."
    fi
    if pm_env_ensure_generated_secret DOCKER_CONTROL_TOKEN "$ENV_FILE" 32; then
        echo "Generated DOCKER_CONTROL_TOKEN in $ENV_FILE (Services-control auth gate)."
    fi
    if pm_env_ensure_generated_secret USAGE_INGEST_TOKEN "$ENV_FILE" 32; then
        echo "Generated USAGE_INGEST_TOKEN in $ENV_FILE (usage-metrics ingest gate)."
    fi
    pm_env_ensure_database_urls "$ENV_FILE"
    pm_env_validate_deploy_required "$ENV_FILE"
fi
COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -f "$ENV_FILE" ]; then
    COMPOSE+=(--env-file "$ENV_FILE")
fi
OLLAMA_URL="http://host.docker.internal:11434"
EMBED_MODEL="qwen3-embedding:4b"
MCP_RUNTIME="node"
if [ -f "$ENV_FILE" ]; then
    # Pull just the keys we care about; tolerate missing keys.
    _ollama=$(grep -E '^OLLAMA_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    _model=$(grep -E '^EMBED_MODEL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    _mcp_runtime=$(grep -E '^PM_MCP_RUNTIME=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    [ -n "$_ollama" ] && OLLAMA_URL="$_ollama"
    [ -n "$_model" ] && EMBED_MODEL="$_model"
    [ -n "$_mcp_runtime" ] && MCP_RUNTIME="$_mcp_runtime"
fi
if [ "$MCP_RUNTIME" = "stream" ]; then
    COMPOSE+=(--profile mcp-stream)
fi

# host.docker.internal is the container's view of the host; from the host
# itself the daemon lives on localhost. Translate for our host-side probe.
OLLAMA_HOST_URL="${OLLAMA_URL/host.docker.internal/localhost}"

# ---------------------------------------------------------------------------
# Idempotency guard. Use `docker compose ps -q --status running` which
# outputs one container ID per line and is fully empty when nothing runs.
# `grep -c .` exits 1 on empty input (would kill the script under set -e),
# so wrap with `|| true` and default empty to 0. We don't drop set -e
# because we DO want a real `docker compose up -d` failure to abort.
#
# Compare against the DEFAULT service count (no profiles) so an
# intentionally-off neo4j profile never makes the stack look "incomplete".
# ---------------------------------------------------------------------------
EXPECTED=$("${COMPOSE[@]}" config --services 2>/dev/null | grep -c . || true)
RUNNING=$("${COMPOSE[@]}" ps -q --status running 2>/dev/null | grep -c . || true)
EXPECTED=${EXPECTED:-0}
RUNNING=${RUNNING:-0}

if [ "$EXPECTED" -gt 0 ] && [ "$RUNNING" -eq "$EXPECTED" ]; then
    echo "=== Persistent-Memory Stack already running — skip ==="
    "${COMPOSE[@]}" ps
    exit 0
fi

echo "=== Starting Persistent-Memory Stack (SERVER) ==="

# ---------------------------------------------------------------------------
# HOST Ollama: the embedding model is served by Ollama on the HOST (same
# pattern as the mem0 stack). Containers reach it at host.docker.internal;
# we probe from the host at localhost.
# ---------------------------------------------------------------------------
if ! curl -sf "${OLLAMA_HOST_URL}/api/tags" >/dev/null 2>&1; then
    echo "Ollama not reachable at ${OLLAMA_HOST_URL} — starting it..."
    if command -v brew >/dev/null 2>&1; then
        brew services start ollama 2>/dev/null || ollama serve &
    else
        ollama serve &
    fi
    # Give the daemon a moment, then re-probe (best-effort).
    for _ in 1 2 3 4 5 6; do
        curl -sf "${OLLAMA_HOST_URL}/api/tags" >/dev/null 2>&1 && break
        sleep 1
    done
fi

if curl -sf "${OLLAMA_HOST_URL}/api/tags" >/dev/null 2>&1; then
    if curl -sf "${OLLAMA_HOST_URL}/api/tags" 2>/dev/null | grep -q "\"${EMBED_MODEL}\""; then
        echo "Ollama OK — embedding model '${EMBED_MODEL}' is present."
    else
        echo "WARNING: Ollama is up but embedding model '${EMBED_MODEL}' is NOT pulled."
        echo "         Server-mode embeddings will fail until you run:"
        echo "             ollama pull ${EMBED_MODEL}"
    fi
else
    echo "WARNING: Ollama still not reachable at ${OLLAMA_HOST_URL}."
    echo "         Server-mode embeddings (EMBED_PROVIDER=ollama) will fail."
    echo "         Start Ollama on the host, then: ollama pull ${EMBED_MODEL}"
fi

"${COMPOSE[@]}" up -d

echo ""
"${COMPOSE[@]}" ps
echo ""
echo "Dashboard:          http://localhost:3200"
echo "Documentation:      http://localhost:3200/docs/index.html"
echo "API:                http://localhost:8090"
echo "Qdrant UI:          http://localhost:7333/dashboard"
echo "Graphiti API docs:  http://localhost:8100/docs"
echo "FalkorDB Browser:   http://localhost:3100"
echo "MinIO Console:      http://localhost:9003   (S3 API on http://localhost:9002)"
echo "Service credentials: dashboard Services page credentials modal"
echo "                     (Qdrant/FalkorDB/MinIO/Neo4j; admin/super-admin only)"
if [ "$MCP_RUNTIME" = "stream" ]; then
    echo "MCP stream:         http://localhost:8091/mcp"
fi
