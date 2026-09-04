#!/usr/bin/env bash
set -euo pipefail

# Internal local-development helper for Claude/Codex/operator updates.
# It never removes volumes and always passes .env.persistent-memory to Compose so
# ${VAR:-default} interpolation matches the runtime env_file values.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_ROOT="${PM_RUNTIME_ROOT:-$REPO_ROOT}"
DASHBOARD_SOURCE_ROOT="${PM_DASHBOARD_SOURCE_ROOT:-$REPO_ROOT}"
ENV_RUNTIME="$RUNTIME_ROOT/.env.persistent-memory"
COMPOSE_FILE="$RUNTIME_ROOT/deploy/compose/docker-compose.yml"
HANDOFF_STATE_DIR="$RUNTIME_ROOT/.local/update-state"
HANDOFF_STATE_FILE="$HANDOFF_STATE_DIR/dashboard-handoff.json"
HANDOFF_RUN_ID="dev-redeploy-$(date -u +"%Y%m%dT%H%M%SZ")-$$"
HANDOFF_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMPOSE_SOURCE_OVERRIDE=""

# shellcheck source=deploy/scripts/lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"

ensure_service_secrets() {
  if [ ! -f "$ENV_RUNTIME" ]; then
    return 0
  fi
  if [ -f "$REPO_ROOT/.env.persistent-memory.example" ]; then
    pm_env_backfill_missing_from_template "$ENV_RUNTIME" "$REPO_ROOT/.env.persistent-memory.example"
  fi
  if pm_env_ensure_generated_secret TOKEN_PEPPER "$ENV_RUNTIME" 43; then
    echo "Generated TOKEN_PEPPER in .env.persistent-memory (token-hash pepper)."
  fi
  if pm_env_ensure_generated_secret POSTGRES_PASSWORD "$ENV_RUNTIME" 36; then
    echo "Generated POSTGRES_PASSWORD in .env.persistent-memory (database owner role)."
  fi
  if pm_env_ensure_generated_secret PM_APP_PASSWORD "$ENV_RUNTIME" 36; then
    echo "Generated PM_APP_PASSWORD in .env.persistent-memory (RLS runtime role)."
  fi
  if pm_env_ensure_generated_secret MINIO_ROOT_PASSWORD "$ENV_RUNTIME" 36; then
    echo "Generated MINIO_ROOT_PASSWORD in .env.persistent-memory (evidence/object store)."
  fi
  if pm_env_ensure_generated_secret FALKORDB_PASSWORD "$ENV_RUNTIME" 36; then
    echo "Generated FALKORDB_PASSWORD in .env.persistent-memory (FalkorDB Browser/Redis auth)."
  fi
  if pm_env_ensure_generated_secret QDRANT_API_KEY "$ENV_RUNTIME" 40; then
    echo "Generated QDRANT_API_KEY in .env.persistent-memory (Qdrant API/dashboard auth)."
  fi
  if pm_env_ensure_generated_secret UPDATE_RUNNER_TOKEN "$ENV_RUNTIME" 32; then
    echo "Generated UPDATE_RUNNER_TOKEN in .env.persistent-memory (dashboard update auth)."
  fi
  if pm_env_ensure_generated_secret DOCKER_CONTROL_TOKEN "$ENV_RUNTIME" 32; then
    echo "Generated DOCKER_CONTROL_TOKEN in .env.persistent-memory (Services-control auth gate)."
  fi
  if pm_env_ensure_generated_secret USAGE_INGEST_TOKEN "$ENV_RUNTIME" 32; then
    echo "Generated USAGE_INGEST_TOKEN in .env.persistent-memory (usage-metrics ingest gate)."
  fi
  pm_env_ensure_database_urls "$ENV_RUNTIME"
  pm_env_validate_deploy_required "$ENV_RUNTIME"
}

ensure_service_secrets

configure_compose() {
  COMPOSE=(docker compose -f "$COMPOSE_FILE")
  if [ -n "$COMPOSE_SOURCE_OVERRIDE" ]; then
    COMPOSE+=(-f "$COMPOSE_SOURCE_OVERRIDE")
  fi
  if [ -f "$ENV_RUNTIME" ]; then
    COMPOSE+=(--env-file "$ENV_RUNTIME")
    if [ "$(pm_env_get PM_MCP_RUNTIME "node" "$ENV_RUNTIME")" = "stream" ]; then
      COMPOSE+=(--profile mcp-stream)
    fi
  fi
}

cleanup_compose_override() {
  if [ -n "$COMPOSE_SOURCE_OVERRIDE" ] && [ -f "$COMPOSE_SOURCE_OVERRIDE" ]; then
    rm -f "$COMPOSE_SOURCE_OVERRIDE"
  fi
}

configure_compose
trap cleanup_compose_override EXIT
# Docker/registry installs can fail under several concurrent BuildKit npm layers
# on fresh laptops. Keep dev redeploy builds conservative unless explicitly tuned.
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"

usage() {
  cat <<'HELP'
dev-redeploy.sh — internal safe update/recovery helper

USAGE
  bash deploy/scripts/dev-redeploy.sh status
  bash deploy/scripts/dev-redeploy.sh verify
  bash deploy/scripts/dev-redeploy.sh backup-db
  PM_RUNTIME_ROOT=/path/to/live/runtime PM_DASHBOARD_SOURCE_ROOT=/path/to/dashboard/source \\
    bash deploy/scripts/dev-redeploy.sh redeploy-dashboard
  bash deploy/scripts/dev-redeploy.sh redeploy-dashboard
  bash deploy/scripts/dev-redeploy.sh redeploy-admin
  bash deploy/scripts/dev-redeploy.sh redeploy-documentation
  bash deploy/scripts/dev-redeploy.sh redeploy-api
  bash deploy/scripts/dev-redeploy.sh redeploy-worker
  bash deploy/scripts/dev-redeploy.sh redeploy-stack
  bash deploy/scripts/dev-redeploy.sh repair-db-roles
  bash deploy/scripts/dev-redeploy.sh clear-local-password
  bash deploy/scripts/dev-redeploy.sh set-local-password '<new password>'

RULES
  - Preserves Docker named volumes. Never runs `down -v`, `rm -v`, or reinstall.
  - Always uses `docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory ...`.
  - Adds the `mcp-stream` profile automatically when PM_MCP_RUNTIME=stream.
  - `redeploy-dashboard` is for UI-only changes; `redeploy-admin` remains an alias.
  - Set PM_RUNTIME_ROOT plus PM_DASHBOARD_SOURCE_ROOT to deploy an isolated worktree
    through the running stack's gateway handoff without copying files into that runtime.
  - `redeploy-documentation` rebuilds only the MkDocs/Node documentation service.
  - `redeploy-api` is for API/shared/db changes and restarts dashboard against it.
  - `repair-db-roles` resets pmuser + pm_app DB passwords from the env file.
  - local password commands affect only the optional dashboard soft lock.
HELP
}

need_env() {
  if [ ! -f "$ENV_RUNTIME" ]; then
    echo "Missing $ENV_RUNTIME. Run the installer first." >&2
    exit 1
  fi
}

api_url() {
  printf '%s\n' "${PM_API_BASE:-http://localhost:8090}"
}

dashboard_url() {
  printf '%s\n' "${PM_DASHBOARD_BASE:-${PM_ADMIN_BASE:-http://localhost:3200}}"
}

current_package_version() {
  node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(pkg.version || "");
' "$DASHBOARD_SOURCE_ROOT/package.json" 2>/dev/null || echo ""
}

resolve_dashboard_service() {
  local services
  services="$("${COMPOSE[@]}" config --services)"
  if printf '%s\n' "$services" | grep -Fxq 'dashboard'; then
    printf '%s\n' 'dashboard'
    return 0
  fi
  if printf '%s\n' "$services" | grep -Fxq 'admin'; then
    printf '%s\n' 'admin'
    return 0
  fi
  echo "The runtime Compose file has neither a dashboard nor an admin service." >&2
  return 1
}

configure_dashboard_source_override() {
  local service="$1"
  if [ "$DASHBOARD_SOURCE_ROOT" = "$RUNTIME_ROOT" ]; then
    return 0
  fi
  if [ ! -f "$DASHBOARD_SOURCE_ROOT/apps/dashboard/Dockerfile" ]; then
    echo "Missing dashboard Dockerfile under PM_DASHBOARD_SOURCE_ROOT=$DASHBOARD_SOURCE_ROOT" >&2
    return 1
  fi
  COMPOSE_SOURCE_OVERRIDE="$(mktemp "${TMPDIR:-/tmp}/persistent-memory-dashboard-source.XXXXXX.yml")"
  DASHBOARD_SOURCE_ROOT="$DASHBOARD_SOURCE_ROOT" \
  DASHBOARD_SERVICE="$service" \
  COMPOSE_SOURCE_OVERRIDE="$COMPOSE_SOURCE_OVERRIDE" \
  node -e '
const fs = require("fs");
const source = process.env.DASHBOARD_SOURCE_ROOT;
const service = process.env.DASHBOARD_SERVICE;
const file = process.env.COMPOSE_SOURCE_OVERRIDE;
fs.writeFileSync(file, `services:\n  ${service}:\n    build:\n      context: ${JSON.stringify(source)}\n      dockerfile: apps/dashboard/Dockerfile\n`, { mode: 0o600 });
'
  configure_compose
}

dashboard_handoff_write() {
  local phase message error progress updated_at target_version
  phase="$1"
  message="$2"
  error="${3:-}"
  progress="${4:-}"
  updated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  target_version="$(current_package_version)"
  mkdir -p "$HANDOFF_STATE_DIR"
  HANDOFF_FILE="$HANDOFF_STATE_FILE" \
  HANDOFF_ID="$HANDOFF_RUN_ID" \
  HANDOFF_PHASE_VALUE="$phase" \
  HANDOFF_MESSAGE="$message" \
  HANDOFF_STARTED_AT="$HANDOFF_STARTED_AT" \
  HANDOFF_UPDATED_AT="$updated_at" \
  HANDOFF_TARGET_VERSION="$target_version" \
  HANDOFF_ERROR="$error" \
  HANDOFF_PROGRESS="$progress" \
  node -e '
const fs = require("fs");
const file = process.env.HANDOFF_FILE;
const phase = process.env.HANDOFF_PHASE_VALUE;
const updatedAt = process.env.HANDOFF_UPDATED_AT;
const version = process.env.HANDOFF_TARGET_VERSION || "";
const state = {
  id: process.env.HANDOFF_ID,
  source: "update-script",
  phase,
  message: process.env.HANDOFF_MESSAGE,
  startedAt: process.env.HANDOFF_STARTED_AT,
  updatedAt
};
if (version) state.targetVersion = version;
const progressRaw = process.env.HANDOFF_PROGRESS || "";
const progress = Number(progressRaw);
if (progressRaw.trim() && Number.isFinite(progress)) state.progress = Math.max(0, Math.min(100, Math.round(progress)));
if (phase === "complete") state.finishedAt = updatedAt;
if (process.env.HANDOFF_ERROR) state.error = process.env.HANDOFF_ERROR;
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, file);
' || echo "Warning: could not write dashboard handoff state." >&2
}

wait_for_dashboard_ready() {
  local url
  url="$(dashboard_url)"
  dashboard_handoff_write "verifying" "Waiting for the refreshed dashboard to accept traffic." "" "96"
  for _ in $(seq 1 90); do
    DASHBOARD_READY_URL="${url%/}/api/update/dashboard-ready" node -e '
const url = process.env.DASHBOARD_READY_URL;
fetch(url, { cache: "no-store" })
  .then(async (res) => {
    const body = await res.json().catch(() => ({}));
    process.exit(res.ok && body && body.ready === true ? 0 : 1);
  })
  .catch(() => process.exit(1));
' >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

dashboard_gateway_targets_canonical() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' persistent-memory-dashboard-gateway 2>/dev/null \
    | grep -qx 'DASHBOARD_BASE_URL=http://persistent-memory-dashboard:3000'
}

cleanup_legacy_dashboard_containers() {
  local cname
  local legacy_containers=(persistent-memory-dashboard-legacy-upgrade persistent-memory-admin)
  for cname in "${legacy_containers[@]}"; do
    if docker inspect "$cname" >/dev/null 2>&1; then
      docker rm -f "$cname" >/dev/null
      echo "Removed legacy ${cname}."
    fi
  done
}

recreate_dashboard_front_door() {
  local force_build="${1:-false}"
  local documentation_args=(up -d)
  local front_door_args=(up -d --no-deps)

  if ! docker image inspect persistent-memory-documentation:latest >/dev/null 2>&1; then
    documentation_args+=(--build)
  fi
  documentation_args+=(documentation)
  "${COMPOSE[@]}" "${documentation_args[@]}"

  if [ "$force_build" = "true" ] \
    || ! docker image inspect persistent-memory-dashboard:latest >/dev/null 2>&1 \
    || ! docker image inspect persistent-memory-dashboard-gateway:latest >/dev/null 2>&1 \
    || ! dashboard_gateway_targets_canonical; then
    front_door_args+=(--build)
  fi
  front_door_args+=(dashboard dashboard-gateway)
  "${COMPOSE[@]}" "${front_door_args[@]}"

  wait_for_dashboard_ready || return 1
  cleanup_legacy_dashboard_containers
}

status() {
  "${COMPOSE[@]}" ps
}

verify() {
  status
  echo ""
  echo "whoami:"
  curl -fsS "$(api_url)/whoami"
  echo ""
  echo ""
  echo "local dashboard auth:"
  curl -fsS "$(api_url)/local/auth" || true
  echo ""
  echo ""
  echo "dashboard /memories:"
  curl -fsS -I "$(dashboard_url)/memories" | sed -n '1,8p'
  echo ""
  echo "memory rows:"
  "${COMPOSE[@]}" exec -T postgres psql -U "$(pm_env_get POSTGRES_USER pmuser "$ENV_RUNTIME")" \
    -d "$(pm_env_get POSTGRES_DB persistent_memory "$ENV_RUNTIME")" \
    -tAc 'select count(*) from memory'
}

backup_db() {
  need_env
  mkdir -p "$RUNTIME_ROOT/.local/backups"
  local ts out
  ts="$(date +%Y%m%d-%H%M%S)"
  out="$RUNTIME_ROOT/.local/backups/persistent-memory-$ts.dump"
  "${COMPOSE[@]}" exec -T postgres pg_dump \
    -U "$(pm_env_get POSTGRES_USER pmuser "$ENV_RUNTIME")" \
    -d "$(pm_env_get POSTGRES_DB persistent_memory "$ENV_RUNTIME")" \
    -Fc > "$out"
  echo "Wrote $out"
}

repair_db_roles() {
  need_env
  local postgres_user postgres_db postgres_password pm_app_password postgres_password_sql pm_app_password_sql
  postgres_user="$(pm_env_get POSTGRES_USER pmuser "$ENV_RUNTIME")"
  postgres_db="$(pm_env_get POSTGRES_DB persistent_memory "$ENV_RUNTIME")"
  postgres_password="$(pm_env_get POSTGRES_PASSWORD pmpass "$ENV_RUNTIME")"
  pm_app_password="$(pm_env_get PM_APP_PASSWORD pmapp "$ENV_RUNTIME")"
  if [[ ! "$postgres_user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Unsafe POSTGRES_USER value in $ENV_RUNTIME" >&2
    exit 1
  fi
  postgres_password_sql="'${postgres_password//\'/\'\'}'"
  pm_app_password_sql="'${pm_app_password//\'/\'\'}'"

  "${COMPOSE[@]}" exec -T postgres psql -U "$postgres_user" -d "$postgres_db" -v ON_ERROR_STOP=1 <<SQL
ALTER USER "$postgres_user" WITH PASSWORD $postgres_password_sql;
ALTER USER pm_app WITH PASSWORD $pm_app_password_sql;
SQL
  echo "Postgres roles repaired from .env.persistent-memory."
}

clear_local_password() {
  curl -fsS -X PUT "$(api_url)/profile" \
    -H 'content-type: application/json' \
    --data '{"removePassword":true}'
  echo ""
}

set_local_password() {
  local pw="${1:-}"
  if [ -z "$pw" ]; then
    echo "Usage: bash deploy/scripts/dev-redeploy.sh set-local-password '<new password>'" >&2
    exit 2
  fi
  local payload
  payload="$(node -e 'console.log(JSON.stringify({password: process.argv[1]}))' "$pw")"
  curl -fsS -X PUT "$(api_url)/profile" \
    -H 'content-type: application/json' \
    --data "$payload"
  echo ""
}

redeploy_dashboard() {
  need_env
  backup_db
  DASHBOARD_SERVICE="$(resolve_dashboard_service)"
  configure_dashboard_source_override "$DASHBOARD_SERVICE"
  dashboard_handoff_write "rebuilding-dashboard" "Rebuilding the dashboard while the gateway keeps open tabs on an update screen." "" "50"
  if ! "${COMPOSE[@]}" build "$DASHBOARD_SERVICE"; then
    dashboard_handoff_write "failed" "Dashboard redeploy failed. Review the terminal output and rerun the helper." "Compose could not build the dashboard service." "100"
    return 1
  fi
  if ! "${COMPOSE[@]}" up -d --no-deps --force-recreate "$DASHBOARD_SERVICE"; then
    dashboard_handoff_write "failed" "Dashboard redeploy failed. Review the terminal output and rerun the helper." "Compose could not rebuild the dashboard service." "100"
    return 1
  fi
  if ! wait_for_dashboard_ready; then
    dashboard_handoff_write "failed" "Dashboard redeploy failed readiness checks. Review the terminal output and rerun the helper." "The dashboard did not become ready through /api/update/dashboard-ready." "100"
    return 1
  fi
  dashboard_handoff_write "complete" "Dashboard redeploy is complete. Reloading the dashboard." "" "100"
  verify
}

redeploy_documentation() {
  need_env
  "${COMPOSE[@]}" up -d --build --no-deps documentation
  "${COMPOSE[@]}" ps documentation
}

redeploy_documentation() {
  need_env
  "${COMPOSE[@]}" up -d --build --no-deps documentation
  "${COMPOSE[@]}" ps documentation
}

redeploy_api() {
  need_env
  backup_db
  "${COMPOSE[@]}" up -d --build --no-deps api worker
  DASHBOARD_SERVICE="$(resolve_dashboard_service)"
  "${COMPOSE[@]}" up -d --no-deps "$DASHBOARD_SERVICE"
  verify
}

redeploy_worker() {
  need_env
  backup_db
  "${COMPOSE[@]}" up -d --build --no-deps worker
  verify
}

redeploy_stack() {
  need_env
  backup_db
  "${COMPOSE[@]}" up -d --build
  verify
}

main() {
  cd "$REPO_ROOT"
  case "${1:-}" in
    status) status ;;
    verify) verify ;;
    backup-db) need_env; backup_db ;;
    redeploy-dashboard|redeploy-admin) redeploy_dashboard ;;
    redeploy-documentation) redeploy_documentation ;;
    redeploy-api) redeploy_api ;;
    redeploy-worker) redeploy_worker ;;
    redeploy-stack) redeploy_stack ;;
    repair-db-roles) repair_db_roles ;;
    clear-local-password) clear_local_password ;;
    set-local-password) shift; set_local_password "$@" ;;
    --help|-h|help|"") usage ;;
    *)
      echo "Unknown command: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
