#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
npm run build:server-mode-install --prefix "$REPO_ROOT"
exec node "$REPO_ROOT/dist/scripts/server-mode-install.js" client-managed "$@"
