#!/usr/bin/env bash
# persistent-memory — onboarding installer launcher (INTERNAL helper).
#
# Do NOT call this directly — run `npm run install-persistent-memory`. It launches
# a LOCAL web wizard (127.0.0.1 only) that detects prerequisites, asks smart
# questions, generates .env.persistent-memory, runs the install with live progress,
# then hands off to the dashboard and self-terminates. Host-only — NEVER containerized or shipped to the server.
set -euo pipefail

# This script lives in deploy/scripts/; the repo root is two levels up.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ONBOARD_DIR="$REPO_ROOT/apps/onboard"
PORT="${ONBOARD_PORT:-4319}"
DASHBOARD_PORT="${PM_DASHBOARD_PORT:-3200}"
DASHBOARD_URL="${DASHBOARD_URL:-${ADMIN_URL:-http://localhost:${DASHBOARD_PORT}}}"

command -v node >/dev/null 2>&1 || { echo "Node 20+ is required: https://nodejs.org"; exit 1; }

echo "→ Preparing the onboarding app…"
( cd "$ONBOARD_DIR" && [ -d node_modules ] || npm ci --silent || npm install --silent )
# Always rebuild the wizard SPA so it matches the current source (a stale web/dist would
# silently serve an old UI after a code change / git pull). The build is ~0.5s.
( cd "$ONBOARD_DIR" && npm run build --silent )

echo "→ Starting the installer on http://127.0.0.1:$PORT"
PM_ROOT="$REPO_ROOT" ONBOARD_PORT="$PORT" DASHBOARD_URL="$DASHBOARD_URL" ADMIN_URL="$DASHBOARD_URL" node "$ONBOARD_DIR/dist/apps/onboard/server/index.js" &
SRV_PID=$!

# Wait for liveness, then open the browser (cross-platform, best-effort).
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.3
done
case "$(uname -s)" in
  Darwin) open "http://127.0.0.1:$PORT" 2>/dev/null || true ;;
  Linux) xdg-open "http://127.0.0.1:$PORT" 2>/dev/null || true ;;
  *) echo "Open http://127.0.0.1:$PORT in your browser." ;;
esac

# The server self-terminates after the redirect to the dashboard (POST /api/shutdown).
wait "$SRV_PID"
