#!/bin/bash
# ============================================================
# Persistent-Memory Stack — Post-Installation Verification
# Checks the installed artifacts and runtime services.
# Run this after deploy/scripts/install.sh (or deploy/scripts/start.sh) to confirm the stack is sane.
#
# Exit codes:
#   0  All checks passed (FAIL=0)
#   1  One or more FAIL — see the printed summary at the bottom
# ============================================================
set -uo pipefail

# This script lives in deploy/scripts/; REPO_ROOT is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/host-platform.sh"
SCRIPT_DIR="$(pm_host_path "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pm_host_pwd)"
HELPER_DIR="$REPO_ROOT/deploy/scripts"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.yml"

# shellcheck source=deploy/scripts/lib/env.sh
. "$HELPER_DIR/lib/env.sh"

# ------------------------------------------------------------
# Colors + counters (inlined — this scaffold has no lib/common.sh yet;
# a later phase may factor these out to mirror the mem0 stack).
# ------------------------------------------------------------
if [ -t 1 ]; then
    GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; CYAN=''; NC=''
fi
PASS=0; FAIL=0; WARN=0
section() { echo ""; echo "=== $1 ==="; }
green()   { echo -e "  ${GREEN}PASS${NC}  $1"; PASS=$((PASS+1)); }
red()     { echo -e "  ${RED}FAIL${NC}  $1"; FAIL=$((FAIL+1)); }
yellow()  { echo -e "  ${YELLOW}WARN${NC}  $1"; WARN=$((WARN+1)); }
waitmsg() { echo -e "  ${CYAN}WAIT${NC}  $1"; }

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
verify-install.sh — Audit the Persistent-Memory scaffold install

USAGE
  deploy/scripts/verify-install.sh           Run all checks; print PASS/FAIL/WARN summary
  deploy/scripts/verify-install.sh --help    This message

WHAT IT CHECKS
  - Prerequisites:  Docker daemon running, docker compose v2 present
  - Env file:       .env.persistent-memory present + required keys defined
  - Containers:     every default SERVER service is Up (and healthy where a
                    healthcheck is defined; qdrant has none by design)
  - DB runtime:     pm_app can authenticate and api/worker DATABASE_URL matches
                    PM_APP_PASSWORD from .env.persistent-memory
  - Ports:          host-mapped ports reachable (API 8090, Dashboard 3200,
                    Qdrant 7333, Graphiti 8100, FalkorDB 3100/6380,
                    Postgres 5433, Redis 6381, MinIO 9002/9003)
  - Host Ollama:    daemon reachable + the configured EMBED_MODEL is pulled

EXIT CODES
  0  All checks passed (FAIL=0)
  1  One or more FAIL — see the printed summary at the bottom
HELP
    exit 0
fi

cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env.persistent-memory"

# Resolve OLLAMA_URL / EMBED_MODEL from the env file (fallback to defaults).
OLLAMA_URL="http://host.docker.internal:11434"
EMBED_MODEL="qwen3-embedding:4b"
MCP_RUNTIME="node"
QDRANT_API_KEY=""
POSTGRES_DB="persistent_memory"
PM_APP_PASSWORD=""
if [ -f "$ENV_FILE" ]; then
    _o=$(pm_env_get OLLAMA_URL "" "$ENV_FILE")
    _m=$(pm_env_get EMBED_MODEL "" "$ENV_FILE")
    _r=$(pm_env_get PM_MCP_RUNTIME "" "$ENV_FILE")
    _q=$(pm_env_get QDRANT_API_KEY "" "$ENV_FILE")
    _db=$(pm_env_get POSTGRES_DB "" "$ENV_FILE")
    _app_pw=$(pm_env_get PM_APP_PASSWORD "" "$ENV_FILE")
    [ -n "${_o:-}" ] && OLLAMA_URL="$_o"
    [ -n "${_m:-}" ] && EMBED_MODEL="$_m"
    [ -n "${_r:-}" ] && MCP_RUNTIME="$_r"
    [ -n "${_q:-}" ] && QDRANT_API_KEY="$_q"
    [ -n "${_db:-}" ] && POSTGRES_DB="$_db"
    [ -n "${_app_pw:-}" ] && PM_APP_PASSWORD="$_app_pw"
fi
OLLAMA_HOST_URL="${OLLAMA_URL/host.docker.internal/localhost}"

# ============================================================
# 1. Prerequisites
# ============================================================
section "1. Prerequisites"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    green "Docker daemon running"
else
    red "Docker daemon not running (start Docker Desktop)"
fi
if docker compose version >/dev/null 2>&1; then
    green "docker compose v2 present"
else
    red "docker compose v2 missing"
fi

# ============================================================
# 2. Env file + required keys
# ============================================================
section "2. Env file"
if [ -f "$ENV_FILE" ]; then
    green ".env.persistent-memory present"
    # Keys every later phase relies on having DEFINED; secrets that must be
    # populated for secured service startup are checked separately below.
    REQUIRED_KEYS=(
        TOKEN_PEPPER PM_HOST_BIND
        OLLAMA_URL EMBED_PROVIDER EMBED_MODEL EMBED_DIM
        EXTRACTION_PROVIDER EXTRACTION_MODEL
        PM_MCP_RUNTIME PM_MCP_STREAM_URL
        GRAPH_BACKEND EMBEDDING_MODE
        FALKORDB_HOST FALKORDB_PORT FALKORDB_PASSWORD QDRANT_URL QDRANT_API_KEY
        POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB PM_APP_PASSWORD DATABASE_URL DATABASE_MIGRATE_URL
        REDIS_URL MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_ENDPOINT
        GRAPHITI_URL API_PORT DEPLOYMENT_MODE
        ARGON2_MEMORY_KIB ARGON2_TIME_COST ARGON2_PARALLELISM
        DOCKER_CONTROL_TOKEN UPDATE_RUNNER_TOKEN USAGE_INGEST_TOKEN
    )
    MISSING_KEYS=()
    for k in "${REQUIRED_KEYS[@]}"; do
        grep -qE "^${k}=" "$ENV_FILE" || MISSING_KEYS+=("$k")
    done
    if [ ${#MISSING_KEYS[@]} -eq 0 ]; then
        green "All required env keys defined (${#REQUIRED_KEYS[@]} keys)"
    else
        red "Missing env keys: ${MISSING_KEYS[*]}"
    fi
    for sk in FALKORDB_PASSWORD QDRANT_API_KEY; do
        v=$(pm_env_get "$sk" "" "$ENV_FILE")
        [ -n "${v:-}" ] && green "${sk} populated" || red "${sk} blank (required for secured service startup)"
    done
    # Provider-owned API keys are required for the selected extraction provider.
    extraction_provider="$(pm_env_get EXTRACTION_PROVIDER anthropic "$ENV_FILE")"
    if [ "$extraction_provider" = "anthropic" ]; then
        v=$(pm_env_get ANTHROPIC_API_KEY "" "$ENV_FILE")
        [ -n "${v:-}" ] && green "ANTHROPIC_API_KEY populated" || red "ANTHROPIC_API_KEY blank (required for Anthropic extraction)"
    elif [ "$extraction_provider" = "openai" ]; then
        v=$(pm_env_get OPENAI_API_KEY "" "$ENV_FILE")
        [ -n "${v:-}" ] && green "OPENAI_API_KEY populated" || red "OPENAI_API_KEY blank (required for OpenAI extraction)"
    fi

else
    red ".env.persistent-memory MISSING"
fi

# A pre-upgrade update-runner asks for the compatibility `admin` service after
# it fast-forwards the checkout. Finish that one-release handoff here because
# the old runner executes this freshly updated verification script.
cleanup_legacy_dashboard_container() {
    local legacy_present=0 canonical_state gateway_state
    local legacy_containers=(persistent-memory-dashboard-legacy-upgrade persistent-memory-admin)
    local compose=(docker compose -f "$COMPOSE_FILE")
    [ -f "$ENV_FILE" ] && compose+=(--env-file "$ENV_FILE")

    for cname in "${legacy_containers[@]}"; do
        docker inspect "$cname" >/dev/null 2>&1 && legacy_present=1
    done
    [ "$legacy_present" -eq 1 ] || return 0

    section "2b. Dashboard service migration"
    canonical_state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' persistent-memory-dashboard 2>/dev/null || true)"
    gateway_state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' persistent-memory-dashboard-gateway 2>/dev/null || true)"
    if [ "$canonical_state" != "healthy" ] || [ "$gateway_state" != "healthy" ]; then
        yellow "Completing the dashboard service rename before removing legacy containers"
        if ! "${compose[@]}" up -d documentation dashboard dashboard-gateway >/dev/null; then
            red "Could not start the canonical dashboard services; legacy containers preserved"
            return 0
        fi
        for _ in $(seq 1 60); do
            canonical_state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' persistent-memory-dashboard 2>/dev/null || true)"
            gateway_state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' persistent-memory-dashboard-gateway 2>/dev/null || true)"
            [ "$canonical_state" = "healthy" ] && [ "$gateway_state" = "healthy" ] && break
            sleep 1
        done
    fi

    if [ "$canonical_state" != "healthy" ] || [ "$gateway_state" != "healthy" ]; then
        red "Canonical dashboard did not become healthy; legacy containers preserved"
        return 0
    fi

    for cname in "${legacy_containers[@]}"; do
        if docker inspect "$cname" >/dev/null 2>&1; then
            if docker rm -f "$cname" >/dev/null 2>&1; then
                green "Removed legacy ${cname} after canonical dashboard verification"
            else
                yellow "Could not remove legacy ${cname}"
            fi
        fi
    done
}

cleanup_legacy_dashboard_container

# ============================================================
# 3. Containers (default profile) — Up + healthy where defined
# ============================================================
section "3. Containers"
# Default services (neo4j is profile-gated and intentionally excluded).
SERVICES=(qdrant falkordb postgres redis minio graphiti dlp api worker dashboard documentation docker-control update-runner)
if [ "$MCP_RUNTIME" = "stream" ]; then
    SERVICES+=(mcp)
fi
# Services that define a healthcheck in the compose (qdrant has none by
# design — its image ships no HTTP client; see the contract gotchas). Keep this
# Bash-3.2-compatible for macOS (/bin/bash has no associative arrays).
has_healthcheck() {
    case "$1" in
        falkordb|postgres|redis|minio|graphiti|dlp|api|worker|dashboard|documentation|docker-control|mcp|update-runner) return 0 ;;
        *) return 1 ;;
    esac
}

for svc in "${SERVICES[@]}"; do
    cname="persistent-memory-${svc}"
    state=$(docker inspect -f '{{.State.Status}}' "$cname" 2>/dev/null || true)
    if [ -z "$state" ]; then
        red "Container ${cname} not found (run deploy/scripts/start.sh)"
        continue
    fi
    if [ "$state" != "running" ]; then
        red "Container ${cname} is '${state}' (expected running)"
        continue
    fi
    if has_healthcheck "$svc"; then
        health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cname" 2>/dev/null || true)
        case "$health" in
            healthy)   green "${cname} running + healthy" ;;
            starting)  waitmsg "${cname} running; healthcheck still starting" ;;
            none)      green "${cname} running (no healthcheck reported)" ;;
            *)         red "${cname} running but health=${health}" ;;
        esac
    else
        green "${cname} running (no healthcheck by design)"
    fi
done

# ============================================================
# 3b. Database runtime credentials
# ============================================================
section "3b. Database runtime credentials"
if [ -z "$PM_APP_PASSWORD" ]; then
    red "PM_APP_PASSWORD missing — api/worker cannot authenticate as pm_app"
else
    if docker exec -e "PGPASSWORD=$PM_APP_PASSWORD" persistent-memory-postgres \
        psql -U pm_app -d "$POSTGRES_DB" -tAc 'select 1' >/dev/null 2>&1; then
        green "pm_app login succeeds with PM_APP_PASSWORD"
    else
        red "pm_app login failed with PM_APP_PASSWORD (run: bash deploy/scripts/dev-redeploy.sh repair-db-roles)"
    fi

    container_env_value() {
        docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
            | awk -F= -v want="$2" '$1 == want { sub(/^[^=]*=/, ""); print; exit }'
    }
    for cname in persistent-memory-api persistent-memory-worker; do
        db_url="$(container_env_value "$cname" DATABASE_URL)"
        if [ -z "$db_url" ]; then
            red "${cname} DATABASE_URL missing"
        elif [[ "$db_url" == *"pm_app:${PM_APP_PASSWORD}@"* ]]; then
            green "${cname} DATABASE_URL matches PM_APP_PASSWORD"
        else
            red "${cname} DATABASE_URL does not match PM_APP_PASSWORD (recreate with: docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory up -d --force-recreate --no-deps api worker)"
        fi
    done
fi

# ============================================================
# 4. Ports reachable (host mappings — developer-facing)
# ============================================================
section "4. Ports"
# tcp_open <host> <port> — pure-bash TCP probe (no curl/nc dependency).
tcp_open() {
    (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && exec 3>&- 2>/dev/null && return 0
    return 1
}
# HTTP probe where a real endpoint exists.
http_ok() { curl -sf --max-time 5 "$1" >/dev/null 2>&1; }
qdrant_http_ok() {
    if [ -n "$QDRANT_API_KEY" ]; then
        curl -sf --max-time 5 -H "api-key: $QDRANT_API_KEY" "$1" >/dev/null 2>&1
    else
        curl -sf --max-time 5 "$1" >/dev/null 2>&1
    fi
}

# Host-facing ports are checked here; service health is verified above through
# container healthchecks.
PORTS=(
    "API:8090" "Dashboard:3200" "Qdrant-REST:7333" "Qdrant-gRPC:7334"
    "Graphiti:8100" "FalkorDB:6380" "FalkorDB-UI:3100"
    "Postgres:5433" "Redis:6381" "MinIO-S3:9002" "MinIO-Console:9003"
)
if [ "$MCP_RUNTIME" = "stream" ]; then
    PORTS+=("MCP-Stream:8091")
fi
for entry in "${PORTS[@]}"; do
    name="${entry%%:*}"
    p="${entry##*:}"
    if tcp_open localhost "$p"; then
        green "Port ${p} (${name}) reachable"
    else
        red "Port ${p} (${name}) NOT reachable"
    fi
done

# Qdrant exposes a real /readyz — assert it if the port was open.
if tcp_open localhost 7333; then
    if qdrant_http_ok "http://localhost:7333/readyz"; then
        green "Qdrant /readyz OK"
    else
        yellow "Qdrant port open but authenticated /readyz not ready yet"
    fi
fi

# ============================================================
# 5. Host Ollama + embedding model
# ============================================================
section "5. Host Ollama"
if http_ok "${OLLAMA_HOST_URL}/api/tags"; then
    green "Ollama reachable at ${OLLAMA_HOST_URL}"
    if curl -sf --max-time 5 "${OLLAMA_HOST_URL}/api/tags" 2>/dev/null | grep -q "\"${EMBED_MODEL}\""; then
        green "Embedding model '${EMBED_MODEL}' pulled"
    else
        red "Embedding model '${EMBED_MODEL}' NOT pulled (run: ollama pull ${EMBED_MODEL})"
    fi
else
    red "Ollama not reachable at ${OLLAMA_HOST_URL} (start it on the host)"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo "============================================"
echo "  Verification Results"
echo "============================================"
echo ""
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo -e "  ${YELLOW}WARN: $WARN${NC}"
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo -e "  ${GREEN}All checks passed!${NC}"
    echo ""
    exit 0
else
    echo -e "  ${RED}$FAIL check(s) failed. Review above for details.${NC}"
    echo -e "  ${CYAN}Tip: a fresh 'starting' health state often clears on a re-run.${NC}"
    echo ""
    exit 1
fi
