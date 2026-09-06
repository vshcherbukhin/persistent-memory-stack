#!/bin/bash
# Stop the Persistent-Memory Stack (SERVER) — idempotent.
# Skips with a clear message if nothing is running, instead of letting
# `docker compose down` print "no resource found" warnings.

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
stop.sh — Stop the Persistent-Memory Stack (SERVER)

USAGE
  deploy/scripts/stop.sh
  deploy/scripts/stop.sh --help | -h

WHAT IT DOES
  Runs `docker compose down` for the SERVER stack containers and removes
  the persistent_memory_network bridge. Stopping does NOT delete data —
  Docker named volumes are preserved.

  The --profile neo4j and --profile mcp-stream flags are passed too, so a neo4j
  container or shared MCP stream service started through a profile is also
  brought down here.
  (Bringing down a profile that was never started is a harmless no-op.)

IDEMPOTENT
  If nothing is currently running, prints
    "=== Persistent-Memory Stack already stopped — skip ==="
  and exits 0 without invoking docker compose. Safe to run on a
  stopped stack.

WHAT IT PRESERVES
  - All Docker named volumes (persistent_memory_qdrant_data,
    persistent_memory_falkordb_data, persistent_memory_postgres_data,
    persistent_memory_redis_data, persistent_memory_minio_data, and
    persistent_memory_neo4j_data) — restart with `deploy/scripts/start.sh` and your
    data is still there.
  - The .env.persistent-memory runtime config and all tracked repo files.
  - Claude/Codex MCP registrations. The supported stream MCP service is stopped
    with the rest of the stack and restarted by `deploy/scripts/start.sh`; legacy command
    entries are migrated by setup/update helpers.

WHAT TO USE FOR A FULL WIPE
  There is no destructive cleanup script in this scaffold phase. To wipe
  data manually:
      docker compose down -v --remove-orphans
  (the -v flag deletes the named volumes — irreversible).
HELP
    exit 0
fi

# This script lives in deploy/scripts/; operate on the repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/host-platform.sh"
SCRIPT_DIR="$(pm_host_path "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pm_host_pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.persistent-memory"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -f "$ENV_FILE" ]; then
    COMPOSE+=(--env-file "$ENV_FILE")
fi
COMPOSE+=(--profile neo4j --profile mcp-stream)

# `docker compose ps -q --status running` outputs one container ID per
# line, fully empty when nothing is running. `grep -c .` exits 1 on
# empty input, so we tolerate that with `|| true` and default to 0.
RUNNING=$("${COMPOSE[@]}" ps -q --status running 2>/dev/null | grep -c . || true)
RUNNING=${RUNNING:-0}
if [ "$RUNNING" -eq 0 ]; then
    echo "=== Persistent-Memory Stack already stopped — skip ==="
    exit 0
fi

echo "=== Stopping Persistent-Memory Stack (SERVER) ==="
# Profile flags ensure profile-gated neo4j and mcp-stream services are also stopped.
"${COMPOSE[@]}" down
echo "Services stopped. Data preserved in Docker volumes."
echo "Full wipe (irreversible): docker compose down -v --remove-orphans"
