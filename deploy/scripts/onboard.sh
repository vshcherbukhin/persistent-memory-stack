#!/usr/bin/env bash
# Compatibility entrypoint: delegate to the validated host launcher, which uses
# the committed lockfile. Prefer `npm run install-persistent-memory`.
set -euo pipefail

# This script lives in deploy/scripts/; the repo root is two levels up.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
command -v node >/dev/null 2>&1 || { echo "Install supported Node.js with npm from https://nodejs.org, then run npm run install-persistent-memory." >&2; exit 1; }
exec node scripts/host-lifecycle.mjs install "$@"
