#!/usr/bin/env bash
set -Eeuo pipefail
# ============================================================
# persistent-memory — update to the latest code (INTERNAL helper).
#
# Do NOT call this directly — run `npm run update-persistent-memory`. Pulls the
# latest code, snapshots local runtime data, ensures any newly introduced local
# service secrets exist, reinstalls + regenerates the Prisma client, rebuilds the
# images, applies any new migrations (idempotent RLS), and restarts the stack.
# Existing .env.persistent-memory values are preserved.
#
# This is install.sh's "bring up + data layer" phases, minus the first-run env
# bootstrap and seed, plus a `git pull` and an image rebuild.
#
# ── TRUST BOUNDARY (read this) ────────────────────────────────────────────────
# This command BUILDS and RUNS whatever it pulls: npm install, `docker compose
# build`, and rls.sql executed as the Postgres SUPERUSER. So running it is
# equivalent to "execute origin/<branch> on this host as me". `git pull --ff-only`
# refuses to clobber your local commits, but it does NOT authenticate the author —
# only run this against a remote you trust. The incoming commits are printed below
# before anything is built, so you can see what you're about to execute.
# ============================================================

# This script lives in deploy/scripts/; the repo root is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SOURCE_REPO_ROOT="${PM_COORDINATOR_SOURCE_ROOT:-$SCRIPT_REPO_ROOT}"
REPO_ROOT="${PM_COORDINATOR_RESOLVED_ROOT:-$SOURCE_REPO_ROOT}"
SOURCE_ENV_RUNTIME="$SOURCE_REPO_ROOT/.env.persistent-memory"
# shellcheck source=deploy/scripts/lib/update-handoff-state.sh
. "$SCRIPT_DIR/lib/update-handoff-state.sh"
LEGACY_HANDOFF_STATE_DIR="$(pm_normalize_handoff_state_dir "$SOURCE_REPO_ROOT" "${PM_LEGACY_HANDOFF_STATE_DIR:-}")"
RUNTIME_HANDOFF_STATE_DIR="$(pm_normalize_handoff_state_dir "$SOURCE_REPO_ROOT" "${PM_HANDOFF_STATE_DIR:-$LEGACY_HANDOFF_STATE_DIR}")"
HANDOFF_STATE_DIR="$RUNTIME_HANDOFF_STATE_DIR"
HANDOFF_STATE_FILE="$HANDOFF_STATE_DIR/dashboard-handoff.json"
DEPLOYED_STATE_DIR="${PM_COORDINATOR_DEPLOYED_STATE_DIR:-$RUNTIME_HANDOFF_STATE_DIR}"
PM_LEGACY_HANDOFF_STATE_DIR="$LEGACY_HANDOFF_STATE_DIR"
PM_HANDOFF_STATE_DIR="$RUNTIME_HANDOFF_STATE_DIR"
export PM_LEGACY_HANDOFF_STATE_DIR PM_HANDOFF_STATE_DIR
# A coordinator run may traverse bridge releases in separate child processes.
# Keep one event id for that lifecycle so a specific child failure cannot be
# replaced by the coordinator's generic fallback event.
HANDOFF_RUN_ID="${PM_HANDOFF_ID:-$(date -u +"%Y%m%dT%H%M%SZ")-$$}"
HANDOFF_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
HANDOFF_PHASE="starting"
HANDOFF_DONE=0
HANDOFF_ACTIVITY_SEQUENCE=0
HANDOFF_FAILURE_DETAIL=""
HANDOFF_PROBE_PID=""

# shellcheck source=deploy/scripts/lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"

configure_update_context() {
    REPO_ROOT="$1"
    cd "$REPO_ROOT"
    ENV_RUNTIME="${PM_COORDINATOR_ENV_RUNTIME:-$REPO_ROOT/.env.persistent-memory}"
    PRISMA_DIR="$REPO_ROOT/layers/core/schema"
    COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.yml"
    COMPOSE=(docker compose -f "$COMPOSE_FILE")
    if [ -f "$ENV_RUNTIME" ]; then
        COMPOSE+=(--env-file "$ENV_RUNTIME")
    fi
    MCP_RUNTIME="node"
    if [ -f "$ENV_RUNTIME" ]; then
        MCP_RUNTIME="$(pm_env_get PM_MCP_RUNTIME "node" "$ENV_RUNTIME")"
    fi
    if [ "$MCP_RUNTIME" = "stream" ]; then
        COMPOSE+=(--profile mcp-stream)
    fi
}

configure_update_context "$REPO_ROOT"
# First-run/update builds are network-heavy across multiple Node images. Keep
# Compose from launching all image builds at once unless an operator overrides it.
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"

ok()   { echo "  [OK]   $1"; }
warn() { echo "  [WARN] $1"; }
fail() {
    echo "  [FAIL] $1"
    if [ -z "$HANDOFF_FAILURE_DETAIL" ]; then
        HANDOFF_FAILURE_DETAIL="$1"
    fi
}
section() { echo ""; echo "============================================"; echo "  $1"; echo "============================================"; echo ""; }

UPDATE_BRANCH_OVERRIDE="${PM_UPDATE_BRANCH:-}"
UPDATE_RELEASE_OVERRIDE="${PM_UPDATE_RELEASE:-}"
UPDATE_RELEASE_BRANCH_EXPLICIT=0
UPDATE_RELEASE_BRANCH_SHORTCUT=0
VERSIONED_WORKTREE="${PM_COORDINATOR_VERSIONED_WORKTREE:-0}"
UPDATE_SHOW_HELP=0

print_update_help() {
    cat <<'HELP'
update.sh — Update the persistent-memory stack to the latest code.

USAGE  (via npm)
  npm run update-persistent-memory
  npm run update-persistent-memory -- --dev
  npm run update-persistent-memory -- --branch <branch>
  npm run update-persistent-memory -- --release <semver> [--branch <branch>]

BRANCH OPTIONS
  By default, the updater fetches and fast-forwards the current checkout branch.
  --dev             update from origin/dev, switching this checkout to dev first
  --branch <name>   update from origin/<name>, switching this checkout first
  PM_UPDATE_BRANCH=<name> npm run update-persistent-memory
                    env form of --branch for non-interactive use

EXACT RELEASE
  --release <semver>  deploy that exact release from origin/master by default.
                     The updater creates or reuses
                     .local/release-worktrees/persistent-memory-<semver>-<commit>, leaving
                     the calling checkout and branch unchanged. Use --branch only
                     when the requested version belongs to another trusted branch.

WHAT IT DOES
  1. snapshot .env, Postgres, volumes, Compose state, MCP report
  2. backfill missing env defaults + generate missing service tokens
  3. git fetch + git merge --ff-only   (current or selected trusted branch)
  4. npm run setup                    (npm install + prisma generate; reports live activity)
  5. build then refresh dashboard-gateway only
  6. build non-gateway images, then recreate them with --no-build
                                       (keeps dashboard-gateway out of the main recreate)
  7. wait for Postgres to be healthy
  8. prisma migrate deploy            (apply any new migrations, as the owner)
  9. deploy/scripts/apply-rls.sh      (container psql; re-apply RLS idempotently)
  10. restart api + worker + docker-control + update-runner as the runtime roles
  11. verify-install.sh
  12. refresh existing Claude/Codex MCP registrations and generated prompt/rule blocks
  13. wait for the refreshed dashboard readiness endpoint
  14. write .local/update-state/last-successful-update.json plus dashboard-handoff.json
      so open/reopened dashboard tabs show release notes without hitting a half-ready app

WHAT IT DOES NOT DO
  - Does NOT replace existing .env.persistent-memory values (your secrets are preserved).
  - Does NOT create Claude/Codex prompt files unless a persistent-memory install artifact already exists.
  - Does NOT re-seed (the bootstrap superuser already exists; seed is skipped).
  - Does NOT delete any data (Docker volumes are preserved).
HELP
}

validate_update_branch_name() {
    local branch
    branch="${1:-}"
    [ -n "$branch" ] || return 1
    [[ "$branch" != -* ]] || return 1
    git check-ref-format --branch "$branch" >/dev/null 2>&1
}

validate_update_release() {
    [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]
}

parse_update_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --help|-h)
                UPDATE_SHOW_HELP=1
                ;;
            --dev)
                UPDATE_BRANCH_OVERRIDE="dev"
                UPDATE_RELEASE_BRANCH_SHORTCUT=1
                ;;
            --master)
                UPDATE_BRANCH_OVERRIDE="master"
                UPDATE_RELEASE_BRANCH_SHORTCUT=1
                ;;
            --branch=*)
                UPDATE_BRANCH_OVERRIDE="${1#*=}"
                UPDATE_RELEASE_BRANCH_EXPLICIT=$((UPDATE_RELEASE_BRANCH_EXPLICIT + 1))
                ;;
            --branch)
                shift
                if [ "$#" -eq 0 ]; then
                    fail "--branch requires a branch name."
                    exit 1
                fi
                UPDATE_BRANCH_OVERRIDE="$1"
                UPDATE_RELEASE_BRANCH_EXPLICIT=$((UPDATE_RELEASE_BRANCH_EXPLICIT + 1))
                ;;
            --release=*)
                UPDATE_RELEASE_OVERRIDE="${1#*=}"
                ;;
            --release)
                shift
                if [ "$#" -eq 0 ]; then
                    fail "--release requires a semantic version."
                    exit 1
                fi
                UPDATE_RELEASE_OVERRIDE="$1"
                ;;
            *)
                fail "Unknown update option: $1"
                echo "        Run npm run update-persistent-memory -- --help for usage."
                exit 1
                ;;
        esac
        shift
    done

    if [ -n "$UPDATE_BRANCH_OVERRIDE" ] && ! validate_update_branch_name "$UPDATE_BRANCH_OVERRIDE"; then
        fail "Invalid update branch: $UPDATE_BRANCH_OVERRIDE"
        exit 1
    fi
    if [ -n "$UPDATE_RELEASE_OVERRIDE" ] && ! validate_update_release "$UPDATE_RELEASE_OVERRIDE"; then
        fail "--release requires a semantic version."
        exit 1
    fi
    if [ -n "$UPDATE_RELEASE_OVERRIDE" ] && [ "$UPDATE_RELEASE_BRANCH_SHORTCUT" -ne 0 ]; then
        fail "--release cannot be combined with --dev or --master."
        exit 1
    fi
    if [ -n "$UPDATE_RELEASE_OVERRIDE" ] && [ "$UPDATE_RELEASE_BRANCH_EXPLICIT" -gt 1 ]; then
        fail "--release can only be combined with one explicit --branch."
        exit 1
    fi
    if [ -n "$UPDATE_RELEASE_OVERRIDE" ] && [ "$UPDATE_RELEASE_BRANCH_EXPLICIT" -eq 0 ]; then
        UPDATE_BRANCH_OVERRIDE="master"
    fi
}

require_clean_worktree_for_branch_switch() {
    if ! git diff --quiet || ! git diff --cached --quiet; then
        fail "Cannot switch update branch with uncommitted tracked changes."
        echo "        Commit or stash local work, then rerun the updater."
        exit 1
    fi
    if [ -n "$(git ls-files --others --exclude-standard)" ]; then
        fail "Cannot switch update branch with untracked files in the checkout."
        echo "        Move, commit, or ignore local files, then rerun the updater."
        exit 1
    fi
}

ensure_tracked_worktree_safe_for_update_merge() {
    local status dirty_paths non_lock_dirty lock_dirty stash_name

    status="$(git status --porcelain --untracked-files=no)"
    [ -n "$status" ] || return 0

    dirty_paths="$(printf '%s\n' "$status" | awk '{print substr($0,4)}')"
    non_lock_dirty="$(printf '%s\n' "$dirty_paths" | grep -Ev '^(package-lock\.json|apps/dashboard/package-lock\.json)$' || true)"
    lock_dirty="$(printf '%s\n' "$dirty_paths" | grep -E '^(package-lock\.json|apps/dashboard/package-lock\.json)$' || true)"

    if [ -n "$non_lock_dirty" ]; then
        fail "Cannot update with uncommitted tracked changes."
        echo "        Commit or stash these files, then rerun npm run update-persistent-memory:"
        printf '%s\n' "$non_lock_dirty" | sed 's/^/          - /'
        if [ -n "$lock_dirty" ]; then
            echo "        Generated lockfile drift is auto-stashed only when it is the only tracked change."
        fi
        exit 1
    fi

    [ -n "$lock_dirty" ] || return 0

    stash_name="persistent-memory pre-update lockfile drift $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    warn "Local generated lockfile changes detected; preserving them before the update merge."
    printf '%s\n' "$lock_dirty" | sed 's/^/        - /'
    if git stash push -m "$stash_name" -- package-lock.json apps/dashboard/package-lock.json >/dev/null; then
        ok "Lockfile drift stashed as: $stash_name"
        echo "        After the update, inspect it with:"
        echo "          git stash list --grep='persistent-memory pre-update lockfile drift'"
    else
        fail "Could not stash generated lockfile changes. Commit or stash them manually, then rerun."
        exit 1
    fi
}

switch_to_update_branch_if_needed() {
    local current_branch target_branch
    current_branch="$1"
    target_branch="$2"
    if [ "$current_branch" = "$target_branch" ]; then
        return 0
    fi

    require_clean_worktree_for_branch_switch
    if git show-ref --verify --quiet "refs/heads/$target_branch"; then
        git switch "$target_branch" >/dev/null
    else
        git switch -c "$target_branch" "origin/$target_branch" >/dev/null
        git branch --set-upstream-to="origin/$target_branch" "$target_branch" >/dev/null 2>&1 || true
    fi
    ok "Switched update checkout from $current_branch to $target_branch."
}

parse_update_args "$@"

is_http_remote_url() {
    case "${1:-}" in
        http://*|https://*) return 0 ;;
        *) return 1 ;;
    esac
}

remote_username_from_url() {
    local remote_url without_scheme userinfo
    remote_url="${1:-}"
    without_scheme="${remote_url#http://}"
    without_scheme="${without_scheme#https://}"
    case "$without_scheme" in
        *@*) ;;
        *) return 0 ;;
    esac
    userinfo="${without_scheme%%@*}"
    printf '%s\n' "${userinfo%%:*}"
}

redacted_remote_url() {
    local remote_url scheme rest
    remote_url="${1:-origin}"
    case "$remote_url" in
        http://*@*|https://*@*)
            scheme="${remote_url%%://*}://"
            rest="${remote_url#*://}"
            printf '%s%s\n' "$scheme" "${rest#*@}"
            ;;
        *) printf '%s\n' "$remote_url" ;;
    esac
}

git_fetch_origin_branch() {
    local branch remote_url provider token git_user askpass rc
    branch="$1"
    remote_url="$(git remote get-url origin 2>/dev/null || echo "origin")"
    provider="none"
    token=""
    git_user=""
    if [ -f "$ENV_RUNTIME" ]; then
        provider="$(pm_env_get UPDATE_CHECK_PROVIDER "none" "$ENV_RUNTIME")"
        token="$(pm_env_get UPDATE_BITBUCKET_TOKEN "" "$ENV_RUNTIME")"
        git_user="$(pm_env_get UPDATE_BITBUCKET_USER "" "$ENV_RUNTIME")"
    fi

    if [ "$provider" = "bitbucket" ] && [ -n "$token" ] && is_http_remote_url "$remote_url"; then
        git_user="${git_user:-$(remote_username_from_url "$remote_url")}"
        git_user="${git_user:-${USER:-git}}"
        askpass="$(mktemp "${TMPDIR:-/tmp}/pm-git-askpass.XXXXXX")"
        chmod 700 "$askpass"
        cat > "$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "$PM_GIT_USERNAME" ;;
  *Password*) printf '%s\n' "$PM_GIT_PASSWORD" ;;
  *) printf '%s\n' "$PM_GIT_PASSWORD" ;;
esac
ASKPASS
        GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass" PM_GIT_USERNAME="$git_user" PM_GIT_PASSWORD="$token" \
            git fetch --quiet origin "$branch"
        rc=$?
        rm -f "$askpass"
        return "$rc"
    fi

    GIT_TERMINAL_PROMPT=0 git fetch --quiet origin "$branch"
}

current_package_version() {
    node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version" 2>/dev/null || echo ""
}

dashboard_handoff_write() {
    local phase message error progress activity_phase activity_status activity_service activity_detail probe_json activity_sequence target_version updated_at
    phase="$1"
    message="$2"
    error="${3:-}"
    progress="${4:-}"
    activity_phase="${5:-}"
    activity_status="${6:-}"
    activity_service="${7:-}"
    activity_detail="${8:-}"
    probe_json="${9:-}"
    activity_sequence="$HANDOFF_ACTIVITY_SEQUENCE"
    if [ -n "$activity_phase" ]; then
        HANDOFF_ACTIVITY_SEQUENCE=$((HANDOFF_ACTIVITY_SEQUENCE + 1))
        activity_sequence="$HANDOFF_ACTIVITY_SEQUENCE"
    fi
    target_version="${HANDOFF_TARGET_VERSION_OVERRIDE:-$(current_package_version)}"
    updated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    HANDOFF_PHASE="$phase"
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
    HANDOFF_ACTIVITY_PHASE="$activity_phase" \
    HANDOFF_ACTIVITY_STATUS="$activity_status" \
    HANDOFF_ACTIVITY_SERVICE="$activity_service" \
    HANDOFF_ACTIVITY_DETAIL="$activity_detail" \
    HANDOFF_ACTIVITY_SEQUENCE="$activity_sequence" \
    HANDOFF_PROBE_JSON="$probe_json" \
    HANDOFF_SOURCE="${PM_HANDOFF_SOURCE:-update-script}" \
    HANDOFF_PROTOCOL_VERSION="${PM_HANDOFF_PROTOCOL_VERSION:-}" \
    node -e '
const fs = require("fs");
const file = process.env.HANDOFF_FILE;
const phase = process.env.HANDOFF_PHASE_VALUE;
const updatedAt = process.env.HANDOFF_UPDATED_AT;
const version = process.env.HANDOFF_TARGET_VERSION || "";
const state = {
  id: process.env.HANDOFF_ID,
  source: process.env.HANDOFF_SOURCE || "update-script",
  phase,
  message: process.env.HANDOFF_MESSAGE,
  startedAt: process.env.HANDOFF_STARTED_AT,
  updatedAt
};
const protocolVersion = Number(process.env.HANDOFF_PROTOCOL_VERSION || "");
if (Number.isInteger(protocolVersion) && protocolVersion > 0) state.protocolVersion = protocolVersion;
if (version) {
  state.targetVersion = version;
  state.releaseNotesVersion = version;
}
const progressRaw = process.env.HANDOFF_PROGRESS || "";
const progress = Number(progressRaw);
if (progressRaw.trim() && Number.isFinite(progress)) state.progress = Math.max(0, Math.min(100, Math.round(progress)));
const cap = (value) => typeof value === "string" ? value.trim().slice(0, 320) : "";
const activityPhase = process.env.HANDOFF_ACTIVITY_PHASE || "";
const activityStatus = process.env.HANDOFF_ACTIVITY_STATUS || "";
const activityService = process.env.HANDOFF_ACTIVITY_SERVICE || "";
const activityDetail = process.env.HANDOFF_ACTIVITY_DETAIL || "";
const activitySequence = Number(process.env.HANDOFF_ACTIVITY_SEQUENCE || "");
if (
  ["setup", "build", "deploy", "verify"].includes(activityPhase)
  && ["running", "done", "failed"].includes(activityStatus)
  && Number.isInteger(activitySequence) && activitySequence >= 0
) {
  const activity = { phase: activityPhase, status: activityStatus, sequence: activitySequence, updatedAt };
  const service = cap(activityService);
  const detail = cap(activityDetail);
  if (service) activity.service = service;
  if (detail) activity.detail = detail;
  state.activity = activity;
}
if (phase === "complete") state.finishedAt = updatedAt;
const error = cap(process.env.HANDOFF_ERROR);
if (error) state.error = error;
const probeRaw = process.env.HANDOFF_PROBE_JSON || "";
if (probeRaw.trim()) {
  try {
    const input = JSON.parse(probeRaw);
    const completed = Number(input?.completed);
    const total = Number(input?.total);
    const remaining = Number(input?.remaining);
    const checkedAt = cap(input?.checkedAt);
    const message = cap(input?.message);
    if (
      Number.isInteger(completed) && completed >= 0
      && Number.isInteger(total) && total >= 0
      && Number.isInteger(remaining) && remaining >= 0
      && remaining === Math.max(0, total - completed)
      && checkedAt && message
    ) state.probe = { message, completed, total, remaining, checkedAt };
  } catch (_) {}
}
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, file);
' || warn "Could not write dashboard update handoff state."
}

dashboard_handoff_activity() {
    local handoff_phase activity_phase activity_status service detail message progress
    handoff_phase="$1"
    activity_phase="$2"
    activity_status="$3"
    service="$4"
    detail="$5"
    message="${6:-$detail}"
    progress="${7:-}"
    dashboard_handoff_write "$handoff_phase" "$message" "" "$progress" \
        "$activity_phase" "$activity_status" "$service" "$detail"
}

stop_progress_probe() {
    local pid="${HANDOFF_PROBE_PID:-}"
    HANDOFF_PROBE_PID=""
    [ -n "$pid" ] || return 0
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
}

run_progress_probe() {
    local label phase progress phase_message interval pid result probe_json message
    label="$1"
    phase="$2"
    progress="$3"
    phase_message="$4"
    shift 4
    interval="${PM_UPDATE_PROGRESS_PROBE_SECONDS:-60}"
    if ! [[ "$interval" =~ ^[1-9][0-9]*$ ]]; then
        interval=60
    fi
    stop_progress_probe
    (
        while true; do
            sleep "$interval"
            if ! result="$("$@")"; then
                warn "${label} progress check failed; the update continues and will retry in ${interval}s."
                continue
            fi
            if ! probe_json="$(HANDOFF_PROBE_RESULT="$result" node -e '
const input = JSON.parse(process.env.HANDOFF_PROBE_RESULT || "");
const completed = Number(input?.completed);
const total = Number(input?.total);
const remaining = Number(input?.remaining);
const checkedAt = typeof input?.checkedAt === "string" ? input.checkedAt.trim().slice(0, 64) : "";
const message = typeof input?.message === "string" ? input.message.trim().slice(0, 320) : "";
if (!Number.isInteger(completed) || completed < 0 || !Number.isInteger(total) || total < 0 || completed > total) process.exit(1);
if (!Number.isInteger(remaining) || remaining !== total - completed || !checkedAt || !message) process.exit(1);
process.stdout.write(JSON.stringify({ completed, total, remaining, checkedAt, message }));
' 2>/dev/null)"; then
                warn "${label} progress check returned invalid data; the update continues and will retry in ${interval}s."
                continue
            fi
            message="$(HANDOFF_PROBE_JSON="$probe_json" node -e 'const v = JSON.parse(process.env.HANDOFF_PROBE_JSON); process.stdout.write(v.message)' 2>/dev/null || true)"
            [ -n "$message" ] || continue
            printf '  [INFO] %s\n' "$message"
            dashboard_handoff_write "$phase" "$phase_message" "" "$progress" \
                "verify" "running" "$label" "$message" "$probe_json"
        done
    ) &
    pid=$!
    HANDOFF_PROBE_PID="$pid"
}

release_coordinator_reservation() {
    if [ "${COORDINATOR_RESERVATION_HELD:-0}" = "1" ]; then
        rm -f "${COORDINATOR_RESERVATION_DIR}/owner.json" 2>/dev/null || true
        rmdir "${COORDINATOR_RESERVATION_DIR}" 2>/dev/null || true
        COORDINATOR_RESERVATION_HELD=0
    fi
}

dashboard_handoff_record_error() {
    local code
    code=$?
    if [ "$code" -ne 0 ] && [ -z "$HANDOFF_FAILURE_DETAIL" ]; then
        HANDOFF_FAILURE_DETAIL="Update command failed with exit code $code during ${HANDOFF_PHASE:-update}."
    fi
}

dashboard_handoff_fail_on_exit() {
    local code error
    code=$?
    stop_progress_probe
    release_coordinator_reservation
    if [ "$code" -ne 0 ] && [ "${HANDOFF_DONE:-0}" != "1" ]; then
        error="${HANDOFF_FAILURE_DETAIL:-Update command failed with exit code $code during ${HANDOFF_PHASE:-update}.}"
        dashboard_handoff_write "failed" "Update failed during ${HANDOFF_PHASE:-update}. Review the error below, then use the terminal for full details." "$error" || true
    fi
}
trap dashboard_handoff_record_error ERR
trap dashboard_handoff_fail_on_exit EXIT

wait_for_dashboard_handoff() {
    local dashboard_url
    dashboard_url="${PM_DASHBOARD_URL:-http://127.0.0.1:3200}"
    for _ in $(seq 1 20); do
        DASHBOARD_HANDOFF_URL="${dashboard_url%/}/api/update/handoff" \
        DASHBOARD_HANDOFF_ID="$HANDOFF_RUN_ID" \
        node -e '
const url = process.env.DASHBOARD_HANDOFF_URL;
const expectedId = process.env.DASHBOARD_HANDOFF_ID;
fetch(url, { cache: "no-store" })
  .then(async (res) => {
    const state = await res.json().catch(() => null);
    process.exit(res.ok && state?.active === true && state.id === expectedId && state.phase === "updating" ? 0 : 1);
  })
  .catch(() => process.exit(1));
' >/dev/null 2>&1 && {
            sleep 2
            ok "Dashboard gateway received the update handoff; allowing open tabs to switch screens."
            return 0
        }
        sleep 0.25
    done
    warn "Dashboard gateway did not acknowledge the handoff yet; continuing and preserving the update event for the next dashboard visit."
}

ensure_service_secrets() {
    if [ ! -f "$ENV_RUNTIME" ]; then
        return 0
    fi
    if [ -f "$REPO_ROOT/.env.persistent-memory.example" ]; then
        pm_env_backfill_missing_from_template "$ENV_RUNTIME" "$REPO_ROOT/.env.persistent-memory.example"
    fi
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
    if pm_env_ensure_generated_secret DOCKER_CONTROL_TOKEN "$ENV_RUNTIME" 32; then
        ok "Generated DOCKER_CONTROL_TOKEN (Services-control auth gate)."
    fi
    if pm_env_ensure_generated_secret UPDATE_RUNNER_TOKEN "$ENV_RUNTIME" 32; then
        ok "Generated UPDATE_RUNNER_TOKEN (update-runner auth gate)."
    fi
    if pm_env_ensure_generated_secret USAGE_INGEST_TOKEN "$ENV_RUNTIME" 32; then
        ok "Generated USAGE_INGEST_TOKEN (usage-metrics ingest gate)."
    fi
    pm_env_ensure_database_urls "$ENV_RUNTIME"
}

reload_compose_from_env() {
    COMPOSE=(docker compose -f "$COMPOSE_FILE")
    if [ -f "$ENV_RUNTIME" ]; then
        COMPOSE+=(--env-file "$ENV_RUNTIME")
        MCP_RUNTIME="$(pm_env_get PM_MCP_RUNTIME "node" "$ENV_RUNTIME")"
    else
        MCP_RUNTIME="node"
    fi
    if [ "$MCP_RUNTIME" = "stream" ]; then
        COMPOSE+=(--profile mcp-stream)
    fi
}

release_at_commit() {
    local commit
    commit="$1"
    git show "$commit:package.json" 2>/dev/null | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const version = JSON.parse(raw).version;
    if (typeof version === "string") process.stdout.write(version);
  } catch {}
});
'
}

resolve_release_commit() {
    local branch release commit candidate
    branch="$1"
    release="$2"
    while IFS= read -r commit; do
        candidate="$(release_at_commit "$commit")"
        if [ "$candidate" = "$release" ]; then
            printf '%s\n' "$commit"
            return 0
        fi
    done < <(git rev-list "origin/$branch")
    return 1
}

resolve_release_worktree() {
    local branch commit worktree_root worktree existing_commit actual_version
    [ -n "$UPDATE_RELEASE_OVERRIDE" ] || return 0

    branch="$UPDATE_BRANCH_OVERRIDE"
    if ! git_fetch_origin_branch "$branch"; then
        fail "git fetch origin $branch failed while resolving release $UPDATE_RELEASE_OVERRIDE."
        exit 1
    fi
    if ! commit="$(resolve_release_commit "$branch" "$UPDATE_RELEASE_OVERRIDE")"; then
        fail "Release $UPDATE_RELEASE_OVERRIDE was not found in origin/$branch."
        echo "        Choose a released version from that branch, or pass --branch <trusted-branch>."
        exit 1
    fi

    worktree_root="${PM_RELEASE_WORKTREE_ROOT:-$SOURCE_REPO_ROOT/.local/release-worktrees}"
    worktree="$worktree_root/persistent-memory-${UPDATE_RELEASE_OVERRIDE}-${commit:0:12}"
    if [ -e "$worktree" ]; then
        if ! git -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            fail "Release worktree path exists but is not a Git worktree: $worktree"
            exit 1
        fi
        existing_commit="$(git -C "$worktree" rev-parse HEAD)"
        if [ "$existing_commit" != "$commit" ]; then
            fail "Release worktree $worktree points to a different commit. Refusing to replace it automatically."
            echo "        Inspect it, then remove it with 'git worktree remove $worktree' only if you intend to recreate it."
            exit 1
        fi
        ok "Reusing release worktree: $worktree"
    else
        if [ ! -f "$SOURCE_ENV_RUNTIME" ]; then
            fail "Cannot create a release worktree without $SOURCE_ENV_RUNTIME."
            exit 1
        fi
        mkdir -p "$worktree_root"
        cd "$SOURCE_REPO_ROOT"
        git worktree add --detach "$worktree" "$commit" >/dev/null
        ( umask 077; cp "$SOURCE_ENV_RUNTIME" "$worktree/.env.persistent-memory"; chmod 600 "$worktree/.env.persistent-memory" )
        ok "Created release worktree: $worktree"
    fi

    configure_update_context "$worktree"
    reload_compose_from_env
    actual_version="$(current_package_version)"
    if [ "$actual_version" != "$UPDATE_RELEASE_OVERRIDE" ]; then
        fail "Release worktree reports version $actual_version, expected $UPDATE_RELEASE_OVERRIDE."
        exit 1
    fi
    VERSIONED_WORKTREE=1
    echo "  Using exact release ${UPDATE_RELEASE_OVERRIDE} from origin/${UPDATE_BRANCH_OVERRIDE}."
}

compose_update_services_excluding_gateway() {
    local service
    UPDATE_RECREATE_SERVICES=()
    while IFS= read -r service; do
        [ -z "$service" ] && continue
        [ "$service" = "dashboard-gateway" ] && continue
        UPDATE_RECREATE_SERVICES+=("$service")
    done < <("${COMPOSE[@]}" config --services)
    if [ "${#UPDATE_RECREATE_SERVICES[@]}" -eq 0 ]; then
        fail "Could not resolve Compose services for update."
        exit 1
    fi
}

run_setup_with_handoff() {
    local pid elapsed heartbeat_seconds progress
    heartbeat_seconds="${PM_UPDATE_BUILD_HEARTBEAT_SECONDS:-10}"
    if ! [[ "$heartbeat_seconds" =~ ^[1-9][0-9]*$ ]]; then
        heartbeat_seconds=10
    fi
    dashboard_handoff_activity "updating" "setup" "running" "update dependencies" \
        "Preparing update dependencies and generated clients. Follow the terminal for the complete live log." \
        "Preparing update dependencies and generated clients. Follow the terminal for the complete live log." "31"
    npm run --silent setup &
    pid=$!
    elapsed=0
    while kill -0 "$pid" 2>/dev/null; do
        sleep 1
        if kill -0 "$pid" 2>/dev/null; then
            elapsed=$((elapsed + 1))
            if [ $((elapsed % heartbeat_seconds)) -eq 0 ]; then
                progress=$((31 + elapsed / heartbeat_seconds))
                if [ "$progress" -lt 44 ]; then
                    dashboard_handoff_activity "updating" "setup" "running" "update dependencies" \
                        "Preparing update dependencies for ${elapsed}s. Follow the terminal for the complete live log." \
                        "Preparing update dependencies for ${elapsed}s. Follow the terminal for the complete live log." "$progress"
                fi
            fi
        fi
    done
    if wait "$pid"; then
        dashboard_handoff_activity "updating" "setup" "done" "update dependencies" "Dependencies and generated clients are ready." \
            "Dependencies and generated clients are ready." "44"
        return 0
    fi
    dashboard_handoff_activity "updating" "setup" "failed" "update dependencies" "Dependency preparation failed. Review the terminal output." \
        "Dependency preparation failed. Review the terminal output."
    return 1
}

compose_build_with_handoff() {
    local label start_progress end_progress pid elapsed heartbeat_seconds progress
    label="$1"
    start_progress="$2"
    end_progress="$3"
    shift 3
    local services=("$@")
    heartbeat_seconds="${PM_UPDATE_BUILD_HEARTBEAT_SECONDS:-10}"
    if ! [[ "$heartbeat_seconds" =~ ^[1-9][0-9]*$ ]]; then
        heartbeat_seconds=10
    fi
    dashboard_handoff_activity "rebuilding-dashboard" "build" "running" "$label" \
        "Docker image build is active. Follow the terminal for the complete live build log." \
        "Building ${label}. Docker image build is active. Follow the terminal for the complete live build log." "$start_progress"
    "${COMPOSE[@]}" build "${services[@]}" &
    pid=$!
    elapsed=0
    while kill -0 "$pid" 2>/dev/null; do
        sleep 1
        if kill -0 "$pid" 2>/dev/null; then
            elapsed=$((elapsed + 1))
            if [ $((elapsed % heartbeat_seconds)) -eq 0 ]; then
                progress=$((start_progress + elapsed / heartbeat_seconds))
                if [ "$progress" -lt "$end_progress" ]; then
                    dashboard_handoff_activity "rebuilding-dashboard" "build" "running" "$label" \
                        "Docker image build is active for ${elapsed}s. Follow the terminal for the complete live build log." \
                        "Building ${label}. Docker image build is active for ${elapsed}s. Follow the terminal for the complete live build log." "$progress"
                fi
            fi
        fi
    done
    if wait "$pid"; then
        dashboard_handoff_write "rebuilding-dashboard" "Built ${label}." "" "$end_progress" \
            "build" "done" "$label" "Docker image build completed."
        return 0
    fi
    dashboard_handoff_activity "rebuilding-dashboard" "build" "failed" "$label" "Docker image build failed. Review the terminal output." \
        "Docker image build failed. Review the terminal output."
    return 1
}

graph_v2_progress_probe() {
    "${COMPOSE[@]}" exec -T worker node dist/graph-v2-progress-cli.js 2>/dev/null | node -e '
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(0, "utf8").trim());
const completed = Number(input?.completed);
const total = Number(input?.total);
const state = typeof input?.state === "string" ? input.state.trim().slice(0, 80) : "running";
if (!Number.isInteger(completed) || completed < 0 || !Number.isInteger(total) || total < 0 || completed > total) process.exit(1);
const remaining = total - completed;
const message = `Graph migration: ${completed} / ${total} complete — ${remaining} remaining (${state}).`;
process.stdout.write(JSON.stringify({ completed, total, remaining, checkedAt: new Date().toISOString(), message }));
'
}

run_graph_v2_migration_with_probe() {
    run_progress_probe "graph migration" "verifying" "87" "Rebuilding and validating project-scoped graph partitions." graph_v2_progress_probe
    if "${COMPOSE[@]}" exec -T worker node dist/graph-v2-migration-cli.js --snapshot-id="$HANDOFF_RUN_ID"; then
        stop_progress_probe
        return 0
    fi
    local code=$?
    stop_progress_probe
    return "$code"
}

mark_update_complete() {
    local state_dir marker version finished_at marker_id branch commit
    state_dir="$DEPLOYED_STATE_DIR"
    marker="$state_dir/last-successful-update.json"
    version="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version" 2>/dev/null || echo "0.0.0")"
    finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    marker_id="${finished_at}-${version}"
    if [ "$VERSIONED_WORKTREE" = "1" ]; then
        branch="$UPDATE_BRANCH_OVERRIDE"
    else
        branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    fi
    commit="$(git rev-parse HEAD 2>/dev/null || true)"
    mkdir -p "$state_dir"
    MARKER_FILE="$marker" \
    MARKER_ID="$marker_id" \
    MARKER_VERSION="$version" \
    MARKER_FINISHED_AT="$finished_at" \
    MARKER_BRANCH="$branch" \
    MARKER_COMMIT="$commit" \
    node -e '
const fs = require("fs");
const marker = {
  id: process.env.MARKER_ID,
  source: "update-script",
  version: process.env.MARKER_VERSION,
  finishedAt: process.env.MARKER_FINISHED_AT,
};
if (process.env.MARKER_BRANCH && process.env.MARKER_BRANCH !== "HEAD") marker.branch = process.env.MARKER_BRANCH;
if (process.env.MARKER_COMMIT) marker.commit = process.env.MARKER_COMMIT;
fs.writeFileSync(process.env.MARKER_FILE, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
'
    if [ "${PM_COORDINATOR_FINAL_HOP:-1}" = "0" ]; then
        dashboard_handoff_write "updating" "Bridge release ${version} is verified. Continuing to the next required release." "" "96"
    else
        dashboard_handoff_write "complete" "Persistent Memory update is complete. Reloading the dashboard." "" "100"
    fi
    HANDOFF_DONE=1
}

wait_for_dashboard_ready() {
    local dashboard_url
    dashboard_url="${PM_DASHBOARD_URL:-http://127.0.0.1:3200}"
    dashboard_handoff_write "verifying" "Waiting for the refreshed dashboard to accept traffic." "" "98"
    for _ in $(seq 1 90); do
        DASHBOARD_READY_URL="${dashboard_url%/}/api/update/dashboard-ready" node -e '
const url = process.env.DASHBOARD_READY_URL;
fetch(url, { cache: "no-store" })
  .then(async (res) => {
    const body = await res.json().catch(() => ({}));
    process.exit(res.ok && body && body.ready === true ? 0 : 1);
  })
  .catch(() => process.exit(1));
' >/dev/null 2>&1 && { ok "Dashboard readiness probe passed."; return 0; }
        sleep 1
    done
    fail "Dashboard did not become ready through ${dashboard_url%/}/api/update/dashboard-ready."
    exit 1
}

wait_for_gateway_ready() {
    local dashboard_url
    dashboard_url="${PM_DASHBOARD_URL:-http://127.0.0.1:3200}"
    for _ in $(seq 1 45); do
        GATEWAY_HEALTH_URL="${dashboard_url%/}/health" node -e '
const url = process.env.GATEWAY_HEALTH_URL;
fetch(url, { cache: "no-store" })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
' >/dev/null 2>&1 && { ok "Dashboard gateway ready."; return 0; }
        sleep 1
    done
    fail "Dashboard gateway did not become ready through ${dashboard_url%/}/health."
    exit 1
}

gateway_mount_source() {
    local destination
    destination="$1"
    docker inspect persistent-memory-dashboard-gateway \
        --format '{{range .Mounts}}{{if eq .Destination "'"$destination"'"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true
}

ensure_dashboard_gateway_handoff_mount() {
    local legacy_mount coordinator_mount dashboard_url
    legacy_mount="$(gateway_mount_source '/run/persistent-memory/update-state')"
    coordinator_mount="$(gateway_mount_source '/run/persistent-memory/update-coordinator-state')"
    if [ "$legacy_mount" = "$LEGACY_HANDOFF_STATE_DIR" ] && [ "$coordinator_mount" = "$PM_COORDINATOR_STATE_DIR" ]; then
        return 0
    fi

    warn "Refreshing dashboard gateway handoff mounts before the update starts."
    "${COMPOSE[@]}" up -d --no-build --no-deps dashboard-gateway >/dev/null 2>&1 || {
        warn "Could not refresh the dashboard gateway handoff mounts; continuing in Terminal-only mode."
        return 0
    }
    dashboard_url="${PM_DASHBOARD_URL:-http://127.0.0.1:3200}"
    for _ in $(seq 1 20); do
        GATEWAY_HEALTH_URL="${dashboard_url%/}/health" node -e '
const url = process.env.GATEWAY_HEALTH_URL;
fetch(url, { cache: "no-store" })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
' >/dev/null 2>&1 && return 0
        sleep 1
    done
    warn "Dashboard gateway handoff mount refresh is still starting; continuing in Terminal-only mode."
}

refresh_agent_artifacts() {
    local onboard_dir agent_update register rule template
    onboard_dir="$REPO_ROOT/apps/onboard"
    agent_update="$onboard_dir/dist/apps/onboard/server/agent-update.js"
    register="$onboard_dir/dist/apps/onboard/server/register.js"
    rule="$onboard_dir/dist/apps/onboard/server/rule.js"
    template="$onboard_dir/dist/apps/onboard/templates/persistent-memory-rule.md"

    # dist/ is intentionally ignored by Git. An older or interrupted install can
    # therefore retain an entry point without the siblings it imports. Rebuild at
    # the point of use so the final refresh never trusts that stale output.
    if [ ! -f "$agent_update" ] || [ ! -f "$register" ] || [ ! -f "$rule" ] || [ ! -f "$template" ]; then
        warn "Agent prompt/rule updater artifacts are incomplete — rebuilding the onboarding helper."
    fi
    npm run --silent build:server --prefix "$onboard_dir" \
        || { fail "Could not rebuild the Claude/Codex artifact refresh helper."; exit 1; }

    if [ ! -f "$agent_update" ] || [ ! -f "$register" ] || [ ! -f "$rule" ] || [ ! -f "$template" ]; then
        fail "Rebuilt Claude/Codex artifact refresh helper is incomplete."
        exit 1
    fi
    PM_ROOT="$REPO_ROOT" node "$REPO_ROOT/apps/onboard/dist/apps/onboard/server/agent-update.js" \
        && ok "Claude/Codex MCP registrations and generated prompts/rules refreshed." \
        || { fail "Claude/Codex agent artifact refresh failed."; exit 1; }
}

if [ "$UPDATE_SHOW_HELP" = "1" ]; then
    print_update_help
    exit 0
fi

reserve_coordinator_before_source_resolution() {
    local coordinator_home
    coordinator_home="$(node "$SOURCE_REPO_ROOT/scripts/install-update-coordinator.mjs" --root "$SOURCE_REPO_ROOT" --print-home)" \
        || { fail "Could not install the update coordinator."; exit 1; }
    COORDINATOR_INSTALLATION_HOME="$(cd "$coordinator_home/../.." && pwd)"
    COORDINATOR_RESERVATION_DIR="$COORDINATOR_INSTALLATION_HOME/update.lock"
    if ! mkdir "$COORDINATOR_RESERVATION_DIR" 2>/dev/null; then
        fail "Persistent Memory update is already running ($COORDINATOR_RESERVATION_DIR)."
        exit 1
    fi
    printf '{"pid":%s,"startedAt":"%s"}\n' "$$" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$COORDINATOR_RESERVATION_DIR/owner.json"
    chmod 600 "$COORDINATOR_RESERVATION_DIR/owner.json"
    COORDINATOR_RESERVATION_HELD=1
    PM_COORDINATOR_LOCK_HELD=1
    export PM_COORDINATOR_LOCK_HELD
}

if [ "${PM_COORDINATOR_ACTIVE:-}" = "1" ] && [ "${PM_COORDINATOR_TARGET_RESOLVED:-}" != "1" ]; then
    fail "Coordinator child was started without a resolved update target."
    exit 1
fi

if [ "${PM_COORDINATOR_ACTIVE:-}" != "1" ]; then
reserve_coordinator_before_source_resolution
PM_COORDINATOR_STATE_DIR="$COORDINATOR_INSTALLATION_HOME/state"
export PM_COORDINATOR_STATE_DIR
ensure_dashboard_gateway_handoff_mount
section "persistent-memory — update"
dashboard_handoff_write "updating" "Preparing a safe update snapshot." "" "5"
wait_for_dashboard_handoff

# ── 0. Resolve the trusted source; coordinator owns the protected snapshot. ──
resolve_release_worktree

if [ "$VERSIONED_WORKTREE" = "1" ]; then
    branch="$UPDATE_BRANCH_OVERRIDE"
    ok "Using exact release $UPDATE_RELEASE_OVERRIDE from origin/$branch."
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    if [ "$current_branch" = "HEAD" ]; then
        fail "Detached HEAD checkouts cannot be updated safely. Switch to a branch first."
        exit 1
    fi
    branch="${UPDATE_BRANCH_OVERRIDE:-$current_branch}"
    remote_url="$(git remote get-url origin 2>/dev/null || echo "origin")"
    if ! git_fetch_origin_branch "$branch"; then
        fail "git fetch origin $branch failed for $(redacted_remote_url "$remote_url")."
        echo "        Check VPN/network and Git access. For HTTPS Bitbucket remotes, configure"
        echo "        dashboard update notifications with a personal Bitbucket token, or configure"
        echo "        Git credentials/SSH for this checkout, then rerun npm run update-persistent-memory."
        exit 1
    fi
    HANDOFF_TARGET_VERSION_OVERRIDE="$(release_at_commit "origin/$branch")"
    dashboard_handoff_write "updating" "Pulling Persistent Memory updates from origin/$branch." "" "18"
    switch_to_update_branch_if_needed "$current_branch" "$branch"
    incoming=$(git log --oneline "HEAD..origin/$branch" 2>/dev/null || true)
    if [ -n "$incoming" ]; then
        echo "  Incoming commits (these will be BUILT and RUN):"
        echo "$incoming" | sed 's/^/    /'
        ensure_tracked_worktree_safe_for_update_merge
    else
        ok "Already up to date with origin/$branch."
    fi
    if ! git merge --ff-only "origin/$branch"; then
        fail "Fast-forward merge failed."
        echo "        This usually means this checkout has local commits that are not on origin/$branch."
        echo "        Run git status --short --branch, then commit/stash local work or rebase before rerunning."
        exit 1
    fi
    ok "Updated to latest origin/$branch."
else
    warn "Not a git checkout — skipping git pull."
fi

# Resolve the real release/branch before the coordinator reads its contract.
# The child invocation skips this source-resolution block, so Git mutation
# happens once while the coordinator validates the actual target and snapshots.
PM_COORDINATOR_INSTALL_ROOT="$SOURCE_REPO_ROOT"
export PM_COORDINATOR_INSTALL_ROOT
COORDINATOR_HOME="$(node "$SOURCE_REPO_ROOT/scripts/install-update-coordinator.mjs" --root "$SOURCE_REPO_ROOT" --print-home)" \
    || { fail "Could not install the update coordinator."; exit 1; }
COORDINATOR_INSTALLATION_HOME="$(cd "$COORDINATOR_HOME/../.." && pwd)"
# The gateway receives this read-only install-scoped state mount. It will
# consume the coordinator event protocol in the next compatibility phase.
PM_COORDINATOR_STATE_DIR="$COORDINATOR_INSTALLATION_HOME/state"
PM_COORDINATOR_TARGET_RESOLVED=1
PM_COORDINATOR_RESOLVED_ROOT="$REPO_ROOT"
PM_COORDINATOR_SOURCE_ROOT="$SOURCE_REPO_ROOT"
PM_COORDINATOR_VERSIONED_WORKTREE="$VERSIONED_WORKTREE"
PM_COORDINATOR_BRANCH="${UPDATE_BRANCH_OVERRIDE:-${branch:-$(git -C "$SOURCE_REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)}}"
PM_HANDOFF_ID="$HANDOFF_RUN_ID"
export PM_COORDINATOR_STATE_DIR PM_COORDINATOR_TARGET_RESOLVED PM_COORDINATOR_RESOLVED_ROOT PM_COORDINATOR_SOURCE_ROOT PM_COORDINATOR_VERSIONED_WORKTREE PM_COORDINATOR_BRANCH PM_COORDINATOR_LOCK_HELD PM_HANDOFF_ID
exec node "$COORDINATOR_HOME/coordinator.mjs" \
    --repo-root "$REPO_ROOT" \
    --legacy-script "$SCRIPT_REPO_ROOT/deploy/scripts/update.sh" \
    -- "$@"
fi

# The coordinator has durably completed the pre-update snapshot before this
# coordinator child can make runtime changes. Reconcile new release env keys
# only after that checkpoint, then recreate Compose arguments from the source
# installation environment.
dashboard_handoff_write "updating" "Checking local service secrets." "" "20"
ensure_service_secrets
pm_env_validate_deploy_required "$ENV_RUNTIME" \
    && ok "Required env values are populated." \
    || { fail "Required env values are missing in $ENV_RUNTIME."; exit 1; }
reload_compose_from_env

# ── 1. Deps + Prisma client ───────────────────────────────────────────────────
dashboard_handoff_write "updating" "Preparing update dependencies and generated clients." "" "30"
run_setup_with_handoff && ok "Dependencies installed + Prisma client generated." \
    || { fail "npm run setup failed."; exit 1; }

# ── 3. Rebuild + bring up ─────────────────────────────────────────────────────
compose_update_services_excluding_gateway
dashboard_handoff_write "rebuilding-dashboard" "Preparing the dashboard update screen." "" "45"
if compose_build_with_handoff "dashboard gateway" "46" "52" dashboard-gateway; then
    ok "Dashboard gateway image rebuilt."
    dashboard_handoff_write "rebuilding-dashboard" "Starting the refreshed dashboard gateway." "" "53" \
        "deploy" "running" "dashboard gateway" "Starting the refreshed dashboard gateway."
    "${COMPOSE[@]}" up -d --no-deps dashboard-gateway >/dev/null \
        && wait_for_gateway_ready \
        || { fail "Could not refresh dashboard-gateway."; exit 1; }
else
    warn "Could not rebuild dashboard-gateway image now — continuing with the running gateway."
fi
compose_build_with_handoff "application images" "55" "73" "${UPDATE_RECREATE_SERVICES[@]}" \
    && ok "Application images rebuilt; dashboard gateway skipped the main recreate." \
    || { fail "docker compose build ${UPDATE_RECREATE_SERVICES[*]} failed."; exit 1; }
dashboard_handoff_write "rebuilding-dashboard" "Starting rebuilt application containers." "" "75" \
    "deploy" "running" "application containers" "Starting rebuilt application containers."
"${COMPOSE[@]}" up -d --no-build "${UPDATE_RECREATE_SERVICES[@]}" && ok "Application containers recreated." \
    || { fail "docker compose up -d --no-build ${UPDATE_RECREATE_SERVICES[*]} failed."; exit 1; }

# ── 4. Wait for Postgres ──────────────────────────────────────────────────────
dashboard_handoff_write "verifying" "Waiting for Postgres and runtime services to settle." "" "78" \
    "verify" "running" "runtime services" "Waiting for Postgres and runtime services to settle."
echo "  Waiting for Postgres to be healthy…"
for _ in $(seq 1 40); do
    h=$(docker inspect -f '{{.State.Health.Status}}' persistent-memory-postgres 2>/dev/null || echo "")
    [ "$h" = "healthy" ] && break
    sleep 1
done
[ "${h:-}" = "healthy" ] && ok "Postgres healthy." || warn "Postgres not reporting healthy — migrate may fail."

# ── 5/6. Migrate + RLS (host-side, owner role, host-rewritten URL) ────────────
dashboard_handoff_write "verifying" "Applying database migrations and Row-Level Security." "" "84" \
    "verify" "running" "database" "Applying database migrations and Row-Level Security."
if [ -f "$ENV_RUNTIME" ] && [ -f "$PRISMA_DIR/schema.prisma" ]; then
    DATABASE_MIGRATE_URL="$(pm_env_get DATABASE_MIGRATE_URL "" "$ENV_RUNTIME")"
    if [ -z "$DATABASE_MIGRATE_URL" ]; then
        fail "DATABASE_MIGRATE_URL is missing in $ENV_RUNTIME."
        exit 1
    fi
    HOST_MIGRATE_URL="${DATABASE_MIGRATE_URL/persistent-memory-postgres:5432/localhost:5433}"

    ( cd "$PRISMA_DIR" && DATABASE_MIGRATE_URL="$HOST_MIGRATE_URL" npm run --silent migrate:deploy ) \
        && ok "Migrations applied (prisma migrate deploy)." \
        || { fail "Prisma migrate deploy failed."; exit 1; }
    ( cd "$REPO_ROOT" && bash deploy/scripts/apply-rls.sh >/dev/null ) \
        && ok "RLS re-applied (container psql, idempotent)." \
        || { fail "rls.sql apply failed."; exit 1; }
else
    warn "No .env.persistent-memory or layers/core/schema/schema.prisma — run the installer first (npm run install-persistent-memory)."
fi

# ── 6b. Graph V2 partition migration ─────────────────────────────────────────
# The external coordinator completed the protected snapshot before this child
# starts. Run the compiled worker command only after Prisma/RLS are current and
# before final runtime verification; the Postgres run record makes interruption
# safe and blocks legacy cleanup until its validation succeeds.
dashboard_handoff_write "verifying" "Rebuilding and validating project-scoped graph partitions." "" "87" \
    "verify" "running" "graph migration" "Rebuilding and validating project-scoped graph partitions."
run_graph_v2_migration_with_probe \
    && ok "Graph V2 migration completed or was already complete." \
    || { fail "Graph V2 migration failed; legacy graph data was preserved for recovery."; exit 1; }

# ── 7. Restart runtime services so they pick up the new images/schema ─────────
RUNTIME_SERVICES=(api worker docker-control update-runner)
if [ "$MCP_RUNTIME" = "stream" ]; then
    RUNTIME_SERVICES+=(mcp)
fi
dashboard_handoff_write "verifying" "Restarting runtime services." "" "90" \
    "deploy" "running" "runtime services" "Restarting runtime services."
"${COMPOSE[@]}" up -d --no-deps "${RUNTIME_SERVICES[@]}" >/dev/null 2>&1 \
    && ok "${RUNTIME_SERVICES[*]} restarted." \
    || warn "Could not restart ${RUNTIME_SERVICES[*]} — run 'docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory up -d'."

# ── 8. Verify ─────────────────────────────────────────────────────────────────
dashboard_handoff_write "verifying" "Running installation verification." "" "94" \
    "verify" "running" "installation" "Running installation verification."
if [ -x "$REPO_ROOT/deploy/scripts/verify-install.sh" ]; then
    bash "$REPO_ROOT/deploy/scripts/verify-install.sh" || warn "verify-install.sh reported issues — review above."
fi

dashboard_handoff_write "verifying" "Refreshing Claude and Codex memory registrations." "" "96" \
    "verify" "running" "AI assistant registrations" "Refreshing Claude and Codex memory registrations."
refresh_agent_artifacts
wait_for_dashboard_ready

section "Update complete"
echo "  Dashboard: http://localhost:3200"
mark_update_complete
