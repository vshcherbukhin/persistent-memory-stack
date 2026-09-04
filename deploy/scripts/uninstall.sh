#!/usr/bin/env bash
set -euo pipefail

# Uninstall the local persistent-memory stack.
# If memory rows exist, offer a dashboard-compatible JSON or encrypted .pm export
# before removing Compose containers, networks, volumes, images, and generated env.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

ENV_RUNTIME="$REPO_ROOT/.env.persistent-memory"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -f "$ENV_RUNTIME" ]; then
    COMPOSE+=(--env-file "$ENV_RUNTIME")
fi
COMPOSE+=(--profile neo4j --profile mcp-stream)

# shellcheck source=deploy/scripts/lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"

POSTGRES_CONTAINER=""
POSTGRES_USER="pmuser"
POSTGRES_DB="persistent_memory"
POSTGRES_PASSWORD=""
TMP_EXPORT=""
POSTGRES_STATE_MISSING=0
OWNERSHIP_MANIFEST="$HOME/.persistent-memory/installer-ownership.json"

section() { echo ""; echo "============================================"; echo "  $1"; echo "============================================"; echo ""; }
ok()      { echo "  [OK]   $1"; }
warn()    { echo "  [WARN] $1"; }
fail()    { echo "  [FAIL] $1"; }

cleanup() {
    if [ -n "$TMP_EXPORT" ]; then
        rm -f "$TMP_EXPORT"
    fi
}
trap cleanup EXIT

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
uninstall.sh — Uninstall the local persistent-memory stack

USAGE
  npm run uninstall-persistent-memory
  bash deploy/scripts/uninstall.sh
  bash deploy/scripts/uninstall.sh --help | -h

WHAT IT DOES
  1. Looks for existing memory records in Postgres.
  2. If records exist, asks whether to export them before uninstall.
  3. Exports either:
       - persistent-memory-export-<timestamp>.json
       - persistent-memory-export-<timestamp>.pm  (encrypted, password protected)
     in the repository root.
  4. Stops and removes the local Compose resources, including their volumes and images.
  5. Removes leftover persistent-memory-* image tags, including old :dev images.
  6. Removes the generated .env.persistent-memory file.

WHAT IT REMOVES
  - Persistent-memory containers and project networks.
  - Docker named and anonymous volumes for the stack.
  - Images used by the Compose stack plus leftover persistent-memory-* images.
  - The generated .env.persistent-memory file.

WHAT IT PRESERVES
  - Existing memory exports are preserved in the repository root.
  - Repository source files are preserved.
  - Modified or unproven Claude/Codex agent configuration is preserved with
    manual cleanup guidance; a full agent cleanup requires an ownership manifest.

ENCRYPTED EXPORT FORMAT
  Secure exports use schema pm.secure-memory-export/1 with PBKDF2-SHA256
  and AES-GCM, matching the dashboard importer.
HELP
    exit 0
fi

prompt_yes_no() {
    local question="${1:?question required}"
    local default="${2:-n}"
    local suffix answer normalized
    if [ "$default" = "y" ]; then
        suffix="[Y/n]"
    else
        suffix="[y/N]"
    fi
    while true; do
        read -r -p "$question $suffix " answer
        answer="${answer:-$default}"
        normalized="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
        case "$normalized" in
            y|yes) return 0 ;;
            n|no) return 1 ;;
            *) echo "Please answer yes or no." ;;
        esac
    done
}

# The installer ownership manifest stores paths, artifact type, scope, and a
# SHA-256 digest only. It never stores tokens, passwords, or file contents.
backup_agent_artifact() {
    local path="${1:?path required}"
    local timestamp backup
    timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
    backup="${path}.persistent-memory-uninstall-${timestamp}.bak"
    cp "$path" "$backup"
    chmod 600 "$backup"
    ok "Created timestamped backup: $backup"
}

artifact_digest() {
    node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$1"
}

remove_owned_mcp_registration() {
    local path="${1:?path required}"
    local scope="${2:?scope required}"
    # Rewrite only our registration; unrelated MCP entries and unrelated TOML tables remain intact.
    node - "$path" "$scope" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const path = process.argv[2]
const scope = process.argv[3]
if (path.endsWith('.json')) {
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (config.mcpServers) delete config.mcpServers['persistent-memory']
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
} else {
  const lines = readFileSync(path, 'utf8').split('\n')
  const owned = /^\s*\[mcp_servers\.(?:persistent-memory|"persistent-memory")(?:\.[^\]]+)?\]\s*$/
  const header = /^\s*\[/
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (owned.test(line)) { skipping = true; continue }
    if (skipping && header.test(line)) skipping = false
    if (!skipping) kept.push(line)
  }
  writeFileSync(path, `${kept.join('\n').replace(/\s+$/, '')}\n`)
}
NODE
}

remove_owned_memory_reference() {
    local path="${1:?path required}"
    # Remove only generated headings so unrelated Markdown sections remain intact.
    node - "$path" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const path = process.argv[2]
const headings = new Set([
  '## Persistent Memory Usage (MANDATORY)',
  '## Memory Save Triggers (MANDATORY)',
  '## Mem0 Issues (MANDATORY)',
  '## Persistent Memory Usage',
  '## Persistent Memory Protocol',
  '## Persistent Memory protocol',
])
const lines = readFileSync(path, 'utf8').split('\n')
const kept = []
let skipping = false
for (const line of lines) {
  if (headings.has(line.trim())) { skipping = true; continue }
  if (skipping && /^#{1,2}\s+/.test(line.trim())) skipping = false
  if (!skipping) kept.push(line)
}
writeFileSync(path, `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`)
NODE
}

report_legacy_agent_artifacts() {
    local detected=0
    if [ -f "$HOME/.claude.json" ] && grep -q '"persistent-memory"' "$HOME/.claude.json"; then
        warn "Legacy install detected in $HOME/.claude.json; it could not be proven installer-owned. Manual cleanup: remove only mcpServers.persistent-memory."
        detected=1
    fi
    if [ -f "$HOME/.codex/config.toml" ] && grep -q '\[mcp_servers\.\("\)\?persistent-memory' "$HOME/.codex/config.toml"; then
        warn "Legacy install detected in $HOME/.codex/config.toml; it could not be proven installer-owned. Manual cleanup: remove only the [mcp_servers.persistent-memory] table."
        detected=1
    fi
    if [ "$detected" -eq 0 ]; then
        ok "No legacy persistent-memory Claude/Codex registration detected."
    fi
}

cleanup_installer_owned_agent_artifacts() {
    if [ ! -f "$OWNERSHIP_MANIFEST" ]; then
        warn "No ownership manifest found; treating this as a legacy install. Agent artifacts could not be proven installer-owned and were preserved."
        report_legacy_agent_artifacts
        return 0
    fi

    local artifact_path artifact_type artifact_scope expected actual unresolved=0 removed=0 manifest_entries
    manifest_entries="$(node - "$OWNERSHIP_MANIFEST" <<'NODE'
const { readFileSync } = require('node:fs')
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (manifest.version !== 1 || !Array.isArray(manifest.artifacts)) throw new Error('invalid ownership manifest')
for (const artifact of manifest.artifacts) {
  if (!artifact || typeof artifact.path !== 'string' || !['mcp-registration', 'memory-rule', 'memory-reference'].includes(artifact.artifactType) || !['global', 'project'].includes(artifact.scope) || !/^[a-f0-9]{64}$/.test(artifact.digest || '')) throw new Error('invalid ownership manifest artifact')
  console.log([artifact.path, artifact.artifactType, artifact.scope, artifact.digest].join('\t'))
}
NODE
    )" || return 1
    while IFS=$'\t' read -r artifact_path artifact_type artifact_scope expected; do
        [ -n "$artifact_path" ] || continue
        if [[ "$artifact_path" != "$HOME/"* ]]; then
            warn "Preserved manifest entry outside the selected home: $artifact_path"
            unresolved=1
            continue
        fi
        if [ ! -f "$artifact_path" ]; then
            warn "Installer-owned artifact already absent: $artifact_path"
            continue
        fi
        if [ "$artifact_type" = "mcp-registration" ] && [ "$artifact_scope" = "project" ] && [ "$(basename "$artifact_path")" = ".claude.json" ]; then
            warn "Preserved ambiguous project-scoped Claude registration: $artifact_path"
            warn "Manual cleanup: remove only projects.<your-project>.mcpServers.persistent-memory after confirming the intended project."
            unresolved=1
            continue
        fi
        actual="$(artifact_digest "$artifact_path")" || return 1
        if [ "$actual" != "$expected" ]; then
            warn "preserved because it was modified: $artifact_path"
            warn "Manual cleanup: remove only the persistent-memory MCP entry/rule after reviewing the timestamped backup guidance."
            unresolved=1
            continue
        fi
        backup_agent_artifact "$artifact_path" || return 1
        case "$artifact_type" in
            mcp-registration) remove_owned_mcp_registration "$artifact_path" "$artifact_scope" || return 1 ;;
            memory-rule) rm -f "$artifact_path" ;;
            memory-reference) remove_owned_memory_reference "$artifact_path" || return 1 ;;
            *) warn "Preserved unknown installer artifact type: $artifact_type ($artifact_path)"; unresolved=1; continue ;;
        esac
        ok "Removed installer-owned agent artifact: $artifact_path ($artifact_type, $artifact_scope scope)"
        removed=$((removed + 1))
    done <<< "$manifest_entries"

    if [ "$unresolved" -eq 0 ]; then
        rm -f "$OWNERSHIP_MANIFEST"
        ok "Removed complete installer ownership manifest after $removed artifact cleanup(s)."
    else
        warn "Ownership manifest retained because one or more artifacts were modified or ambiguous."
    fi
}

choose_agent_cleanup() {
    if prompt_yes_no "Remove detected installer-owned Claude/Codex MCP registrations and generated rules first?" "y"; then
        cleanup_installer_owned_agent_artifacts || return 1
        return 0
    fi
    warn "Stack-only removal leaves Claude/Codex MCP registrations and generated rules in place."
    if prompt_yes_no "Proceed with stack-only removal?" "n"; then
        return 0
    fi
    warn "Uninstall cancelled before stack removal."
    return 1
}

require_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        fail "Docker not found. Nothing can be uninstalled."
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        fail "Docker daemon is not running. Start Docker Desktop and re-run uninstall."
        exit 1
    fi
}

wait_for_postgres() {
    local status
    for _ in $(seq 1 45); do
        POSTGRES_CONTAINER="$("${COMPOSE[@]}" ps -q postgres 2>/dev/null | head -1 || true)"
        if [ -n "$POSTGRES_CONTAINER" ]; then
            status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)"
            if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
                return 0
            fi
        fi
        sleep 1
    done
    return 1
}

prepare_postgres_for_export() {
    if [ ! -f "$ENV_RUNTIME" ]; then
        warn "No .env.persistent-memory found, so memory records cannot be inspected."
        return 1
    fi

    POSTGRES_USER="$(pm_env_get POSTGRES_USER pmuser "$ENV_RUNTIME")"
    POSTGRES_DB="$(pm_env_get POSTGRES_DB persistent_memory "$ENV_RUNTIME")"
    POSTGRES_PASSWORD="$(pm_env_get POSTGRES_PASSWORD "" "$ENV_RUNTIME")"

    POSTGRES_CONTAINER="$("${COMPOSE[@]}" ps -q postgres 2>/dev/null | head -1 || true)"
    if [ -z "$POSTGRES_CONTAINER" ]; then
        if docker volume inspect persistent_memory_postgres_data >/dev/null 2>&1; then
            warn "Postgres is not running; starting only postgres temporarily to inspect memories."
            "${COMPOSE[@]}" up -d postgres >/dev/null
        else
            warn "No persistent-memory Postgres volume/container found."
            POSTGRES_STATE_MISSING=1
            return 1
        fi
    else
        local running
        running="$(docker inspect -f '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || echo false)"
        if [ "$running" != "true" ]; then
            warn "Postgres container exists but is stopped; starting it temporarily to inspect memories."
            "${COMPOSE[@]}" up -d postgres >/dev/null
        fi
    fi

    if ! wait_for_postgres; then
        warn "Postgres did not become ready; memory records cannot be inspected."
        return 1
    fi
    POSTGRES_CONTAINER="$("${COMPOSE[@]}" ps -q postgres 2>/dev/null | head -1 || true)"
    [ -n "$POSTGRES_CONTAINER" ]
}

run_psql_scalar() {
    local sql="${1:?sql required}"
    docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
        psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -v ON_ERROR_STOP=1 -c "$sql" \
        | tr -d '[:space:]'
}

memory_count() {
    local has_table
    has_table="$(run_psql_scalar "SELECT CASE WHEN to_regclass('public.memory') IS NULL THEN '0' ELSE '1' END;")"
    if [ "$has_table" != "1" ]; then
        printf '0\n'
        return 0
    fi
    run_psql_scalar "SELECT count(*) FROM public.memory;"
}

export_memories_json() {
    local target="${1:?target required}"
    umask 077
    docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
        psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --quiet > "$target" <<'SQL'
COPY (
  SELECT jsonb_pretty(
    jsonb_build_object(
      'schema', 'pm.memory-export/1',
      'count', (SELECT count(*) FROM public.memory),
      'exportedAt', to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'exportOptions', jsonb_build_object(
        'exportType', 'standard',
        'project', NULL,
        'createdById', NULL
      ),
      'filters', jsonb_build_object(
        'project', NULL,
        'createdById', NULL
      ),
      'memories', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', m.id::text,
              'content', m.content,
              'category', m.category,
              'shape', m.shape::text,
              'entities', to_jsonb(m.entities),
              'project', m.project,
              'sessionId', m.session_id,
              'createdById', m.created_by_id::text,
              'embeddingStatus', m.embedding_status::text,
              'createdAt', to_char((m.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'updatedAt', to_char((m.updated_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'memoryTier', m.memory_tier::text,
              'sourceProvenance', m.source_provenance::text,
              'confidence', m.confidence,
              'verified', m.verified,
              'archived', (m.archived_at IS NOT NULL),
              'metadata', m.metadata
            )
            ORDER BY m.created_at ASC, m.id ASC
          )
          FROM public.memory m
        ),
        '[]'::jsonb
      )
    )
  )
) TO STDOUT;
SQL
}

read_export_password() {
    local pass confirm
    while true; do
        printf 'Export password (minimum 8 characters): ' >&2
        read -r -s pass
        printf '\n' >&2
        if [ "${#pass}" -lt 8 ]; then
            printf '  [WARN] Password must be at least 8 characters.\n' >&2
            continue
        fi
        printf 'Confirm export password: ' >&2
        read -r -s confirm
        printf '\n' >&2
        if [ "$pass" != "$confirm" ]; then
            printf '  [WARN] Passwords did not match.\n' >&2
            continue
        fi
        printf '%s' "$pass"
        return 0
    done
}

encrypt_export() {
    local input="${1:?input required}"
    local output="${2:?output required}"
    local passphrase="${3:?passphrase required}"
    umask 077
    NODE_PM_EXPORT_PASSWORD="$passphrase" node - "$input" "$output" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const { randomBytes, pbkdf2Sync, createCipheriv } = require('node:crypto')

const [input, output] = process.argv.slice(2)
const passphrase = process.env.NODE_PM_EXPORT_PASSWORD || ''
const iterations = 210000
const salt = randomBytes(16)
const iv = randomBytes(12)
const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256')
const payload = JSON.parse(readFileSync(input, 'utf8'))
payload.exportOptions = { ...(payload.exportOptions || {}), exportType: 'secure' }
const plain = Buffer.from(JSON.stringify(payload), 'utf8')
const cipher = createCipheriv('aes-256-gcm', key, iv)
const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
const envelope = {
  schema: 'pm.secure-memory-export/1',
  exportOptions: payload.exportOptions,
  crypto: {
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
  },
  payload: encrypted.toString('base64'),
}
writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 })
NODE
}

export_prompt_if_needed() {
    local count timestamp json_file secure_file passphrase
    if ! prepare_postgres_for_export; then
        if [ "$POSTGRES_STATE_MISSING" = "1" ]; then
            ok "No memory database found; skipping export prompt."
            return 0
        fi
        if prompt_yes_no "Continue uninstall without checking/exporting memories?" "n"; then
            return 0
        fi
        fail "Uninstall cancelled."
        exit 1
    fi

    count="$(memory_count)"
    if [ "${count:-0}" -eq 0 ]; then
        ok "No memory records found; skipping export prompt."
        return 0
    fi

    echo "Found $count memory record(s)."
    if ! prompt_yes_no "Export memories before uninstalling the stack?" "y"; then
        warn "Continuing without memory export. Docker volumes and images will be removed."
        return 0
    fi

    timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
    json_file="$REPO_ROOT/persistent-memory-export-$timestamp.json"
    secure_file="$REPO_ROOT/persistent-memory-export-$timestamp.pm"

    if prompt_yes_no "Create encrypted export?" "y"; then
        TMP_EXPORT="$(mktemp "$REPO_ROOT/.persistent-memory-export.XXXXXX.json")"
        export_memories_json "$TMP_EXPORT"
        passphrase="$(read_export_password)"
        encrypt_export "$TMP_EXPORT" "$secure_file" "$passphrase"
        ok "Encrypted memory export written: $secure_file"
    else
        export_memories_json "$json_file"
        ok "Memory export written: $json_file"
    fi
}

remove_project_images() {
    local images=()
    local image
    while IFS= read -r image; do
        [ -n "$image" ] && images+=("$image")
    done < <(
        docker image ls --format '{{.Repository}}:{{.Tag}}' \
            | awk '/^persistent-memory(-|:)/ && $0 !~ /:<none>$/ { print }' \
            | sort -u
    )
    if [ "${#images[@]}" -eq 0 ]; then
        ok "No leftover persistent-memory image tags found."
        return 0
    fi
    docker image rm -f "${images[@]}" >/dev/null
    ok "Removed leftover persistent-memory image tags (${#images[@]})."
}

remove_generated_env() {
    if [ -f "$ENV_RUNTIME" ]; then
        rm -f "$ENV_RUNTIME"
        ok "Removed generated .env.persistent-memory."
    else
        ok "No .env.persistent-memory file found."
    fi
}

uninstall_stack() {
    section "Uninstall stack"
    if ! prompt_yes_no "Remove persistent-memory containers, networks, volumes, images, and generated env now?" "y"; then
        warn "Uninstall cancelled. Any export created above was kept."
        exit 0
    fi

    "${COMPOSE[@]}" down --remove-orphans --volumes --rmi all
    ok "Persistent-memory Compose resources removed."
    remove_project_images
    remove_generated_env
}

if [[ "${1:-}" == "--agent-cleanup-only" ]]; then
    cleanup_installer_owned_agent_artifacts
    exit $?
fi

section "persistent-memory — uninstall"
if ! choose_agent_cleanup; then
    fail "Agent cleanup was not completed; stack resources were left untouched."
    exit 1
fi
require_docker
export_prompt_if_needed
uninstall_stack

section "Uninstall complete"
echo "  Reinstall later with: npm run install-persistent-memory"
echo "  Exports, if created, are in: $REPO_ROOT"
