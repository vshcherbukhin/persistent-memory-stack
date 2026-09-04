#!/bin/bash
set -euo pipefail
# ============================================================
# Persistent-Memory Stack — One-Click Server Installation
#
# Runs prereq checks, bootstraps the .env from the committed template, brings
# the SERVER stack up, and applies the data layer as the owner role:
#   prisma migrate deploy -> rls.sql (pm_app role + RLS; password via PGOPTIONS)
#   -> seed (bootstrap superuser + show-once token) -> restart api/worker as pm_app.
# MinIO buckets + Graphiti graph indices are created automatically at runtime by
# the api/worker/graphiti services on first use. MCP registration is handled by
# the onboarding wizard: a shared Streamable HTTP MCP service for local personal
# stacks and shared-memory connections.
#
# Architecture (target):
#   Claude/Codex -> persistent-memory-mcp (shared Streamable HTTP service)
#                         | HTTP over API_URL
#   persistent-memory-api (TS/Node) ──┬─ Qdrant (vectors)
#                                     ├─ Graphiti -> FalkorDB (graph, PRIMARY)
#                                     ├─ Postgres (metadata, RLS)
#                                     ├─ Redis (BullMQ broker) -> worker (TS)
#                                     └─ MinIO (evidence blobs)
#   persistent-memory-dashboard (TS/Next.js) -> API   (runtime toggles, incl.
#                                                   server vs client-bridge
#                                                   embedding mode)
#   Ollama runs on the HOST (host.docker.internal:11434), serves embeddings.
#
# Usage: ./install.sh [--help|-h]
# ============================================================

# SCRIPT_DIR = this script's dir (deploy/scripts/); INSTALL_DIR = the repo root,
# where deploy/compose/docker-compose.yml + .env.persistent-memory live.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

ENV_TEMPLATE="$INSTALL_DIR/.env.persistent-memory.example"
COMPOSE_FILE="$INSTALL_DIR/deploy/compose/docker-compose.yml"
# docker compose reads .env.persistent-memory directly (env_file: in the compose).
# The committed .example carries safe non-secret defaults + empty placeholders for
# the API keys. The runtime .env.persistent-memory is gitignored; we copy it from
# the .example below if absent, backfill newly introduced keys on old installs,
# generate machine-owned secrets, then fail fast if user-owned required values
# are still blank.
ENV_RUNTIME="$INSTALL_DIR/.env.persistent-memory"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -f "$ENV_RUNTIME" ]; then
    COMPOSE+=(--env-file "$ENV_RUNTIME")
fi

# Default values used only for the host-side Ollama prereq probe; the real
# values come from the env template once present.
DEFAULT_OLLAMA_URL="http://host.docker.internal:11434"
DEFAULT_EMBED_MODEL="qwen3-embedding:4b"

# shellcheck source=deploy/scripts/lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"

# ---------------------------------------------------------------------------
# Tiny output helpers (kept inline — this scaffold has no lib/ module set yet;
# a later phase may factor these into persistent-memory/lib/common.sh to mirror
# the mem0 stack's structure).
# ---------------------------------------------------------------------------
section() { echo ""; echo "============================================"; echo "  $1"; echo "============================================"; echo ""; }
ok()      { echo "  [OK]   $1"; }
warn()    { echo "  [WARN] $1"; }
fail()    { echo "  [FAIL] $1"; }
todo()    { echo "  [TODO] $1"; }

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
install.sh — Set up the Persistent-Memory stack (Phase 1 SCAFFOLD)

USAGE
  ./install.sh
  ./install.sh --help | -h

WHAT IT DOES (Phase 1 — scaffolding only)
  1. Prerequisites    — checks for Docker (daemon running) + docker compose,
                        the HOST Ollama daemon, and the configured embedding
                        model. Emits actionable hints; does NOT auto-install.
  2. Env bootstrap    — copies .env.persistent-memory from the committed
                        .example (safe defaults + empty secret placeholders) if absent.
                        Fails if a required value is still blank.
  3. Bring up         — `docker compose up -d` for the SERVER stack (delegates
                        to deploy/scripts/start.sh so the Ollama/idempotency logic is shared).
  4. Per-service setup — STUBBED. Prints TODO markers for the work that later
                        phases own (Prisma migrate, MinIO buckets, Graphiti
                        init, MCP registration, admin seed).
  5. Next steps        — prints URLs and what to do once the real builds land.

WHAT IT DOES NOT DO YET (later phases)
  - No Prisma schema / migrate (layers/core/schema/ is an empty .gitkeep dir this phase).
  - No MinIO bucket creation.
  - No Graphiti graph bootstrap.
  - No ~/.claude.json / Claude Desktop MCP registration.
  - No admin user / token seeding (Argon2 + TOKEN_PEPPER hashing).
  Each is marked [TODO] with the owning phase in the output.

ENVIRONMENT VARIABLES
  INSTALL_DIR  Override the install location (defaults to the directory
               this script lives in).
HELP
    exit 0
fi

echo ""
echo "============================================"
echo "  Persistent-Memory Stack — Installation"
echo "  (Phase 1 — scaffolding)"
echo "============================================"

# ============================================================
# Phase 1: Prerequisites
# ============================================================
section "Phase 1: Prerequisites"

PREREQ_FAIL=0

# --- Docker daemon + compose ---
if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        ok "Docker daemon is running."
    else
        fail "Docker is installed but the daemon is NOT running — start Docker Desktop and re-run."
        PREREQ_FAIL=1
    fi
else
    fail "Docker not found — install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    PREREQ_FAIL=1
fi

if docker compose version >/dev/null 2>&1; then
    ok "docker compose (v2) available."
else
    fail "docker compose v2 not available — update Docker Desktop / install the compose plugin."
    PREREQ_FAIL=1
fi

# --- Resolve OLLAMA_URL / EMBED_MODEL from the template if present ---
OLLAMA_URL="$DEFAULT_OLLAMA_URL"
EMBED_MODEL="$DEFAULT_EMBED_MODEL"
if [ -f "$ENV_TEMPLATE" ]; then
    _ollama=$(grep -E '^OLLAMA_URL=' "$ENV_TEMPLATE" | head -1 | cut -d= -f2- || true)
    _model=$(grep -E '^EMBED_MODEL=' "$ENV_TEMPLATE" | head -1 | cut -d= -f2- || true)
    [ -n "${_ollama:-}" ] && OLLAMA_URL="$_ollama"
    [ -n "${_model:-}" ] && EMBED_MODEL="$_model"
fi
# Containers see host.docker.internal; from the host the daemon is on localhost.
OLLAMA_HOST_URL="${OLLAMA_URL/host.docker.internal/localhost}"

# --- Host Ollama daemon ---
if curl -sf "${OLLAMA_HOST_URL}/api/tags" >/dev/null 2>&1; then
    ok "Ollama reachable at ${OLLAMA_HOST_URL}."
    # --- Embedding model pulled? ---
    if curl -sf "${OLLAMA_HOST_URL}/api/tags" 2>/dev/null | grep -q "\"${EMBED_MODEL}\""; then
        ok "Embedding model '${EMBED_MODEL}' is pulled."
    else
        warn "Embedding model '${EMBED_MODEL}' NOT pulled — server-mode embeddings will fail. Run: ollama pull ${EMBED_MODEL}"
    fi
else
    warn "Ollama not reachable at ${OLLAMA_HOST_URL} — start it (e.g. 'brew services start ollama') and run: ollama pull ${EMBED_MODEL}"
fi

if [ "$PREREQ_FAIL" -ne 0 ]; then
    echo ""
    fail "Prerequisite check failed — fix the [FAIL] items above and re-run ./install.sh"
    exit 1
fi

# ============================================================
# Phase 2: Env bootstrap
# ============================================================
section "Phase 2: Environment"

# The runtime .env.persistent-memory is gitignored (it holds real secrets). The
# committed .example is the template; we copy it over if the runtime is absent,
# then the operator fills the secrets. compose's env_file points at the runtime.
if [ -f "$ENV_RUNTIME" ]; then
    ok "Env file present: $ENV_RUNTIME"
elif [ -f "$ENV_TEMPLATE" ]; then
    cp "$ENV_TEMPLATE" "$ENV_RUNTIME"
    ok "Created $ENV_RUNTIME from $(basename "$ENV_TEMPLATE") — fill in the secrets."
else
    fail "Neither $ENV_RUNTIME nor $ENV_TEMPLATE found — re-checkout the repo."
    exit 1
fi
pm_env_backfill_missing_from_template "$ENV_RUNTIME" "$ENV_TEMPLATE"

# Generate local service secrets if blank. The onboard wizard sets these itself;
# this covers the CLI install path and old env files missing newer sidecar tokens.
if pm_env_ensure_generated_secret TOKEN_PEPPER "$ENV_RUNTIME" 43; then
    ok "Generated TOKEN_PEPPER (token-hash pepper)."
fi
if pm_env_ensure_generated_secret POSTGRES_PASSWORD "$ENV_RUNTIME" 36; then
    ok "Generated POSTGRES_PASSWORD (database owner role)."
fi
if pm_env_ensure_generated_secret PM_APP_PASSWORD "$ENV_RUNTIME" 36; then
    ok "Generated PM_APP_PASSWORD (RLS runtime role)."
fi
if pm_env_ensure_generated_secret MINIO_ROOT_PASSWORD "$ENV_RUNTIME" 36; then
    ok "Generated MINIO_ROOT_PASSWORD (evidence/object store)."
fi
if pm_env_ensure_generated_secret FALKORDB_PASSWORD "$ENV_RUNTIME" 36; then
    ok "Generated FALKORDB_PASSWORD (FalkorDB Browser/Redis auth)."
fi

if pm_env_ensure_generated_secret QDRANT_API_KEY "$ENV_RUNTIME" 40; then
    ok "Generated QDRANT_API_KEY (Qdrant API/dashboard auth)."
fi

# Generate the docker-control shared secret if blank (the Services-page auth
# gate).
if pm_env_ensure_generated_secret DOCKER_CONTROL_TOKEN "$ENV_RUNTIME" 32; then
    ok "Generated DOCKER_CONTROL_TOKEN (Services-control auth gate)."
fi

# Generate the update-runner shared secret if blank (the dashboard update gate).
if pm_env_ensure_generated_secret UPDATE_RUNNER_TOKEN "$ENV_RUNTIME" 32; then
    ok "Generated UPDATE_RUNNER_TOKEN (update-runner auth gate)."
fi

# Generate the usage-ingest secret if blank (gates POST /internal/usage; graphiti
# reports LLM token usage for the dashboard Usage page).
if pm_env_ensure_generated_secret USAGE_INGEST_TOKEN "$ENV_RUNTIME" 32; then
    ok "Generated USAGE_INGEST_TOKEN (usage-metrics ingest gate)."
fi
pm_env_ensure_database_urls "$ENV_RUNTIME"

# Compose-time ${VAR:-default} interpolation is NOT fed by service-level
# env_file:. Rebuild the command after the runtime env exists so every direct
# compose call in this script uses the same values as the containers.
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_RUNTIME")

pm_env_validate_deploy_required "$ENV_RUNTIME" \
    && ok "Required env values are populated." \
    || { fail "Required env values are missing in $ENV_RUNTIME."; exit 1; }

# ============================================================
# Phase 3: Bring up the SERVER stack
# ============================================================
section "Phase 3: Bring up SERVER stack"
# Delegate to start.sh so the Ollama check + idempotency logic stays in one
# place. start.sh runs Compose with --env-file .env.persistent-memory for the
# default services.
if [ -x "$SCRIPT_DIR/start.sh" ]; then
    "$SCRIPT_DIR/start.sh"
else
    warn "start.sh not executable — running 'docker compose up -d' directly."
    ( cd "$INSTALL_DIR" && "${COMPOSE[@]}" up -d )
fi

# ============================================================
# Phase 4: Per-service setup
# ============================================================
section "Phase 4: Per-service setup"

# ── Postgres: migrate (owner) → RLS policies + pm_app role → seed (owner) ──
# Apply order is load-bearing (see layers/core/schema/rls.sql header):
#   1. migrate deploy as OWNER (pmuser)   — creates tables owned by pmuser
#   2. container psql rls.sql as OWNER    — creates the pm_app RLS-subject role
#                                            (password from PM_APP_PASSWORD),
#                                            grants, GUC helper fns, ENABLE+FORCE
#                                            RLS, policies. MUST run AFTER migrate
#                                            (tables must exist) and BEFORE the
#                                            app connects as pm_app.
#   3. seed as OWNER                      — owner bypasses FORCE'd RLS, so it can
#                                            insert the first team/superuser with
#                                            no app.team_id set; mints the
#                                            show-once bootstrap token.
#   4. restart api/worker                 — they pick up DATABASE_URL=pm_app
#                                            (RLS-subject) and the new health probe.
PRISMA_DIR="$INSTALL_DIR/layers/core/schema"

if [ -d "$PRISMA_DIR" ] && [ -f "$PRISMA_DIR/schema.prisma" ]; then
    # Read DATABASE_MIGRATE_URL literally, without sourcing the .env as shell
    # code. Host-side Prisma targets the PUBLISHED host port 5433, not the
    # compose network name. RLS itself runs through the Postgres container's psql.
    DATABASE_MIGRATE_URL="$(pm_env_get DATABASE_MIGRATE_URL "" "$ENV_RUNTIME")"
    if [ -z "$DATABASE_MIGRATE_URL" ]; then
        fail "DATABASE_MIGRATE_URL is missing in $ENV_RUNTIME."
        exit 1
    fi
    HOST_MIGRATE_URL="${DATABASE_MIGRATE_URL/persistent-memory-postgres:5432/localhost:5433}"

    # 1. migrate (owner) — creates tables owned by pmuser.
    ( cd "$PRISMA_DIR" && DATABASE_MIGRATE_URL="$HOST_MIGRATE_URL" npm run --silent migrate:deploy ) \
        && ok "Prisma migrate deploy (as owner pmuser)." \
        || { fail "Prisma migrate deploy failed."; exit 1; }

    # 2. RLS (owner) — use the Postgres container's psql so the host needs no
    # postgres client. apply-rls.sh preserves the PGOPTIONS GUC contract.
    ( cd "$INSTALL_DIR" && bash deploy/scripts/apply-rls.sh >/dev/null ) \
        && ok "RLS policies + pm_app role applied (container psql, as owner)." \
        || { fail "rls.sql apply failed."; exit 1; }

    # 3. seed (owner) — bootstrap superuser + show-once token (idempotent).
    ( cd "$PRISMA_DIR" && DATABASE_MIGRATE_URL="$HOST_MIGRATE_URL" npm run --silent seed ) \
        && ok "Seed complete (bootstrap superuser; token shown above if first run)." \
        || warn "Seed step reported an error — review output above."

    # 4. restart api/worker so they connect as pm_app (RLS-subject) at runtime.
    ( cd "$INSTALL_DIR" && "${COMPOSE[@]}" up -d --no-deps api worker >/dev/null 2>&1 ) \
        && ok "api + worker restarted as pm_app (RLS-subject runtime role)." \
        || warn "Could not restart api/worker — run 'docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory up -d api worker'."
else
    todo "Postgres schema: layers/core/schema/ has no schema.prisma yet. [Phase: API/data layer]"
fi

# MinIO evidence bucket + Graphiti graph indices are created automatically at
# runtime by the api/worker/graphiti services (no manual step). The bootstrap
# superuser + its show-once token are minted by the seed step above; further
# users/tokens are issued from the dashboard webapp.
todo "MCP registration: use the onboarding wizard to register the stream service."
todo "Before PRODUCTION: set the real extraction provider API key in the env."

# ============================================================
# Phase 5: Summary
# ============================================================
section "Server installation complete"
echo "  Server services (default profile):"
echo "    Dashboard:          http://localhost:3200"
echo "    API:                http://localhost:8090"
echo "    Qdrant UI:          http://localhost:7333/dashboard"
echo "    Graphiti API docs:  http://localhost:8100/docs"
echo "    FalkorDB Browser:   http://localhost:3100"
echo "    MinIO Console:      http://localhost:9003   (S3 API on http://localhost:9002)"
echo "    Service credentials: open the dashboard Services page credentials modal"
echo "                         (Qdrant/FalkorDB/MinIO/Neo4j; admin/super-admin only)"
echo ""
echo "  Alt graph backend (OFF by default):"
echo "    docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory --profile neo4j up -d"
echo "                                            # starts persistent-memory-neo4j"
echo "    Neo4j Browser: http://localhost:7475   (Bolt on localhost:7688)"
echo ""
echo "  Helper scripts (in $INSTALL_DIR/):"
echo "    deploy/scripts/start.sh           — Start the SERVER stack (idempotent)."
echo "    deploy/scripts/stop.sh            — Stop (preserves data in Docker volumes)."
echo "    deploy/scripts/verify-install.sh  — Audit containers, ports, env, and host Ollama."
echo ""
echo "  Verify:"
echo "    deploy/scripts/verify-install.sh"
echo ""
echo "  NOTE: The server stack is fully built (api/worker/mcp/graphiti/dashboard/documentation)"
echo "        and the data layer is applied (migrate + RLS + seed). Remaining:"
echo "        fill real secrets for production, then run onboarding MCP registration"
echo "        if Claude/Codex have not been configured yet."
