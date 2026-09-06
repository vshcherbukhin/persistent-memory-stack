#!/usr/bin/env bash
# Start and operate the disposable, isolated integration-test stack.
#
# This script intentionally never reads .env.persistent-memory. It creates a
# separate server-mode stack with its own containers, images, network, volumes,
# host-port range and bootstrap credential under .local/dev-test-stack/.
#
# Commands:
#   up      build/start the test API + worker and seed its empty database
#   run     prove the target is the test stack, then run the live HTTP suite
#   status  show only test-stack containers
#   down    remove only the test-stack containers, network and volumes
#   reset   down, then create a newly seeded test stack
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/host-platform.sh"
SCRIPT_DIR="$(pm_host_path "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pm_host_pwd)"
cd "$REPO_ROOT"

STACK_NAME="persistent-memory-devtest"
STACK_DIR="$REPO_ROOT/.local/dev-test-stack"
ENV_FILE="$STACK_DIR/.env"
TOKEN_FILE="$STACK_DIR/bootstrap-token"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.yml"
RLS_SQL="$REPO_ROOT/layers/core/schema/rls.sql"
COMMAND="${1:-status}"

fail() { echo "ERROR: [dev-test-stack] $*" >&2; exit 1; }
note() { echo "[dev-test-stack] $*"; }
random_secret() { openssl rand -hex 32; }
free_loopback_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

write_env() {
  [ -f "$ENV_FILE" ] && return 0
  mkdir -p "$STACK_DIR"
  umask 077
  {
    printf '%s\n' '# Generated disposable integration stack. Never copy this into a personal deployment.'
    printf '%s\n' 'PM_TEST_STACK=true'
    printf '%s\n' "PM_RUNTIME_ENV_FILE=$ENV_FILE"
    printf '%s\n' 'PM_CONTAINER_PREFIX=persistent-memory-devtest'
    printf '%s\n' 'PM_IMAGE_PREFIX=persistent-memory-devtest'
    printf '%s\n' 'PM_VOLUME_PREFIX=persistent_memory_devtest'
    printf '%s\n' 'PM_NETWORK_NAME=persistent_memory_devtest_network'
    printf '%s\n' 'PM_HOST_BIND=127.0.0.1'
    printf '%s\n' "PM_API_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_POSTGRES_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_QDRANT_HTTP_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_QDRANT_GRPC_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_FALKORDB_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_FALKORDB_BROWSER_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_REDIS_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_MINIO_API_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_MINIO_CONSOLE_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_GRAPHITI_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_MCP_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_DASHBOARD_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_NEO4J_HTTP_PORT=$(free_loopback_port)"
    printf '%s\n' "PM_NEO4J_BOLT_PORT=$(free_loopback_port)"
    printf '%s\n' 'DEPLOYMENT_MODE=server'
    printf '%s\n' 'POSTGRES_USER=pmuser'
    printf '%s\n' "POSTGRES_PASSWORD=$(random_secret)"
    printf '%s\n' 'POSTGRES_DB=persistent_memory'
    printf '%s\n' "PM_APP_PASSWORD=$(random_secret)"
    printf '%s\n' "TOKEN_PEPPER=$(random_secret)"
    printf '%s\n' "GRAPH_GROUP_SECRET=$(random_secret)"
    printf '%s\n' "QDRANT_API_KEY=$(random_secret)"
    printf '%s\n' "FALKORDB_PASSWORD=$(random_secret)"
    printf '%s\n' "MINIO_ROOT_PASSWORD=$(random_secret)"
    printf '%s\n' 'MINIO_ROOT_USER=pmtest'
    printf '%s\n' 'EMBED_PROVIDER=ollama'
    printf '%s\n' 'EMBED_MODEL=qwen3-embedding:4b'
    printf '%s\n' 'EMBED_DIM=2560'
    printf '%s\n' 'EMBEDDING_MODE=server'
    printf '%s\n' 'OLLAMA_URL=http://host.docker.internal:11434'
    printf '%s\n' 'GRAPH_BACKEND=falkordb'
    printf '%s\n' 'FALKORDB_HOST=persistent-memory-devtest-falkordb'
    printf '%s\n' 'FALKORDB_PORT=6379'
    printf '%s\n' 'FALKORDB_DATABASE=default_db'
    printf '%s\n' 'FALKORDB_QUERY_TIMEOUT_MS=5000'
    printf '%s\n' 'PII_GATE_ENABLED=true'
    printf '%s\n' 'PII_INGEST_GATE_ENABLED=true'
    printf '%s\n' 'PII_SCORE_THRESHOLD=0.5'
    printf '%s\n' 'DLP_TIMEOUT_MS=4000'
    printf '%s\n' 'EXTRACTION_PROVIDER=anthropic'
    printf '%s\n' 'EXTRACTION_MODEL=claude-haiku-4-5-20251001'
    printf '%s\n' 'ANTHROPIC_API_KEY='
    printf '%s\n' 'OPENAI_API_KEY='
    printf '%s\n' 'EXTRACTION_BASE_URL='
    printf '%s\n' "USAGE_INGEST_TOKEN=$(random_secret)"
    printf '%s\n' "DOCKER_CONTROL_TOKEN=$(random_secret)"
    printf '%s\n' "UPDATE_RUNNER_TOKEN=$(random_secret)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  note "Created isolated test configuration at .local/dev-test-stack/.env."
  note "Set a scoped ANTHROPIC_API_KEY or OPENAI_API_KEY there before running the suite."
}

assert_test_env() {
  [ -f "$ENV_FILE" ] || fail "No test stack configuration exists. Run '$0 up' first."
  grep -qx 'PM_TEST_STACK=true' "$ENV_FILE" || fail "Refusing: $ENV_FILE is not the disposable test-stack configuration."
  grep -qx 'PM_CONTAINER_PREFIX=persistent-memory-devtest' "$ENV_FILE" || fail "Refusing: test container prefix was changed."
  grep -qx 'PM_VOLUME_PREFIX=persistent_memory_devtest' "$ENV_FILE" || fail "Refusing: test volume prefix was changed."
}

compose() {
  docker compose -p "$STACK_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

load_env() {
  set -a
  # The file is generated here with literal key/value pairs and mode 0600.
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

wait_for_api() {
  local deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl --fail --silent "http://127.0.0.1:${PM_API_PORT}/health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  compose logs --tail=120 api worker >&2 || true
  fail "API did not become healthy within three minutes."
}

wait_for_postgres() {
  local deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  compose logs --tail=100 postgres >&2 || true
  fail "Postgres did not become ready within two minutes."
}

seed_stack() {
  load_env
  if [ -s "$TOKEN_FILE" ]; then
    note "Disposable database is already seeded; preserving its protected test token."
    return 0
  fi
  note "Applying schema, RLS and the disposable bootstrap identity."
  DATABASE_MIGRATE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PM_POSTGRES_PORT}/${POSTGRES_DB}" \
    npm run --silent migrate:deploy -w persistent-memory-prisma
  PGPASSWORD="$POSTGRES_PASSWORD" PGOPTIONS="-c pm.app_password=$PM_APP_PASSWORD" \
    compose exec -T -e PGPASSWORD -e PGOPTIONS postgres \
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < "$RLS_SQL"
  local existing_superusers
  existing_superusers="$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM app_user WHERE admin_level = 'superuser'")"
  [ "${existing_superusers//[[:space:]]/}" = "0" ] || fail "Test database already has a superuser but no protected token. Run '$0 reset' rather than minting another credential."
  DATABASE_MIGRATE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PM_POSTGRES_PORT}/${POSTGRES_DB}" \
    TOKEN_PEPPER="$TOKEN_PEPPER" DEPLOYMENT_MODE=server \
    EMBED_MODEL="$EMBED_MODEL" EMBED_DIM="$EMBED_DIM" EMBEDDING_MODE="$EMBEDDING_MODE" \
    EXTRACTION_PROVIDER="$EXTRACTION_PROVIDER" EXTRACTION_MODEL="$EXTRACTION_MODEL" \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" OPENAI_API_KEY="$OPENAI_API_KEY" \
    BOOTSTRAP_TOKEN_OUTPUT_PATH="$TOKEN_FILE" \
    npm run --silent seed -w persistent-memory-prisma > /dev/null
  [ -s "$TOKEN_FILE" ] || fail "The test bootstrap token was not created."
  chmod 600 "$TOKEN_FILE"
  compose up -d --no-deps api worker >/dev/null
}

assert_provider_ready() {
  load_env
  case "$EXTRACTION_PROVIDER" in
    anthropic) [ -n "${ANTHROPIC_API_KEY:-}" ] || fail "Set ANTHROPIC_API_KEY in .local/dev-test-stack/.env before running live writes." ;;
    openai) [ -n "${OPENAI_API_KEY:-}" ] || fail "Set OPENAI_API_KEY in .local/dev-test-stack/.env before running live writes." ;;
    *) fail "EXTRACTION_PROVIDER must be anthropic or openai in the test-stack env." ;;
  esac
}

case "$COMMAND" in
  up)
    write_env
    assert_test_env
    load_env
    compose up -d --build postgres qdrant redis minio graphiti dlp
    wait_for_postgres
    seed_stack
    compose up -d --build api worker
    wait_for_api
    note "Disposable DEV test stack is ready at http://127.0.0.1:${PM_API_PORT}."
    ;;
  run)
    assert_test_env
    assert_provider_ready
    load_env
    [ -s "$TOKEN_FILE" ] || fail "No test bootstrap token exists. Run '$0 up' first."
    PM_API_BASE="http://127.0.0.1:${PM_API_PORT}" \
      PM_BOOTSTRAP_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")" \
      PM_ALLOW_LIVE_INTEGRATION=1 PM_TEST_STACK=1 \
      npm run test:integration
    ;;
  status)
    assert_test_env
    compose ps
    ;;
  down)
    assert_test_env
    compose down --volumes --remove-orphans
    rm -f "$TOKEN_FILE"
    note "Removed only persistent-memory-devtest containers, network and volumes."
    ;;
  reset)
    assert_test_env
    compose down --volumes --remove-orphans
    rm -f "$TOKEN_FILE"
    "$0" up
    ;;
  *)
    fail "Usage: $0 {up|run|status|down|reset}"
    ;;
esac
