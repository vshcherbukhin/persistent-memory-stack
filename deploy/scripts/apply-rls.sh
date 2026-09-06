#!/usr/bin/env bash
# Apply layers/core/schema/rls.sql through the Postgres container's psql.
#
# This deliberately avoids a host-side psql dependency. The pm_app password is
# passed as a server GUC through PGOPTIONS, matching the psql-18-safe contract in
# layers/core/schema/rls.sql.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/host-platform.sh"
SCRIPT_DIR="$(pm_host_path "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pm_host_pwd)"
ENV_RUNTIME="$REPO_ROOT/.env.persistent-memory"
RLS_SQL="$REPO_ROOT/layers/core/schema/rls.sql"

# shellcheck source=deploy/scripts/lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"

POSTGRES_USER="$(pm_env_get POSTGRES_USER "${POSTGRES_USER:-pmuser}" "$ENV_RUNTIME")"
POSTGRES_PASSWORD="$(pm_env_get POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-pmpass}" "$ENV_RUNTIME")"
POSTGRES_DB="$(pm_env_get POSTGRES_DB "${POSTGRES_DB:-persistent_memory}" "$ENV_RUNTIME")"
PM_APP_PASSWORD="$(pm_env_get PM_APP_PASSWORD "${PM_APP_PASSWORD:-pmapp}" "$ENV_RUNTIME")"
: "${POSTGRES_USER:=pmuser}"
: "${POSTGRES_PASSWORD:=pmpass}"
: "${POSTGRES_DB:=persistent_memory}"
: "${PM_APP_PASSWORD:=pmapp}"

if [ ! -f "$RLS_SQL" ]; then
  echo "rls.sql not found at $RLS_SQL" >&2
  exit 1
fi

docker exec -i \
  -e "PGPASSWORD=$POSTGRES_PASSWORD" \
  -e "PGOPTIONS=-c pm.app_password=$PM_APP_PASSWORD" \
  persistent-memory-postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  < "$RLS_SQL"
