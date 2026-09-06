#!/usr/bin/env bash
# Read dotenv-style KEY=value files without sourcing them as shell code.

pm_env_get() {
    local key="${1:?key required}"
    local fallback="${2-}"
    local file="${3:-${ENV_RUNTIME:-}}"

    if [ -z "$file" ] || [ ! -f "$file" ]; then
        printf '%s\n' "$fallback"
        return 0
    fi

    awk -v want="$key" -v fallback="$fallback" '
        BEGIN { found = 0 }
        /^[[:space:]]*(#|$)/ { next }
        {
            line = $0
            sub(/\r$/, "", line)
            eq = index(line, "=")
            if (eq <= 1) next
            k = substr(line, 1, eq - 1)
            gsub(/^[ \t]+|[ \t]+$/, "", k)
            if (k != want) next

            v = substr(line, eq + 1)
            sub(/^[ \t]+/, "", v)
            sub(/[ \t]+$/, "", v)
            if (length(v) >= 2 && substr(v, 1, 1) == "\"" && substr(v, length(v), 1) == "\"") {
                v = substr(v, 2, length(v) - 2)
            }
            print v
            found = 1
            exit
        }
        END { if (!found) print fallback }
    ' "$file"
}

pm_env_put() {
    local key="${1:?key required}"
    local value="${2:?value required}"
    local file="${3:-${ENV_RUNTIME:-}}"
    local tmp

    if [ -z "$file" ]; then
        echo "pm_env_put requires a file path" >&2
        return 2
    fi

    tmp="${file}.tmp"
    if [ -f "$file" ]; then
        awk -v want="$key" -v replacement="$key=$value" '
            BEGIN { wrote = 0 }
            {
                line = $0
                eq = index(line, "=")
                k = eq > 0 ? substr(line, 1, eq - 1) : ""
                gsub(/^[ \t]+|[ \t]+$/, "", k)
                if (k == want) {
                    if (!wrote) {
                        print replacement
                        wrote = 1
                    }
                    next
                }
                print line
            }
            END { if (!wrote) print replacement }
        ' "$file" > "$tmp"
    else
        printf '%s=%s\n' "$key" "$value" > "$tmp"
    fi
    mv "$tmp" "$file"
}

pm_random_alnum() {
    local length="${1:-32}"
    node -e '
const crypto = require("crypto")
const length = Number(process.argv[1] || 32)
let out = ""
while (out.length < length) {
  out += crypto.randomBytes(length).toString("base64").replace(/[^A-Za-z0-9]/g, "")
}
process.stdout.write(out.slice(0, length))
' "$length"
}

pm_env_ensure_generated_secret() {
    local key="${1:?key required}"
    local file="${2:-${ENV_RUNTIME:-}}"
    local length="${3:-32}"
    local current value

    current="$(pm_env_get "$key" "" "$file")"
    if [ -n "$current" ]; then
        return 1
    fi

    value="$(pm_random_alnum "$length")"
    pm_env_put "$key" "$value" "$file"
    return 0
}

pm_env_backfill_missing_from_template() {
    local file="${1:?env file required}"
    local template="${2:?env template required}"
    local tmp missing

    if [ ! -f "$template" ]; then
        echo "Env template missing: $template" >&2
        return 2
    fi
    if [ ! -f "$file" ]; then
        cp "$template" "$file"
        pm_env_reconcile_memory_surfaces "$file"
        return 0
    fi

    tmp="${file}.missing"
    awk -F= '
        FNR == NR {
            line = $0
            sub(/\r$/, "", line)
            if (line ~ /^[[:space:]]*(#|$)/) next
            eq = index(line, "=")
            if (eq <= 1) next
            k = substr(line, 1, eq - 1)
            gsub(/^[ \t]+|[ \t]+$/, "", k)
            have[k] = 1
            next
        }
        {
            line = $0
            sub(/\r$/, "", line)
            if (line ~ /^[[:space:]]*(#|$)/) next
            eq = index(line, "=")
            if (eq <= 1) next
            k = substr(line, 1, eq - 1)
            gsub(/^[ \t]+|[ \t]+$/, "", k)
            if (!have[k] && !added[k]) {
                print line
                added[k] = 1
            }
        }
    ' "$file" "$template" > "$tmp"

    if [ -s "$tmp" ]; then
        {
            printf '\n# Added by persistent-memory env backfill from %s\n' "$(basename "$template")"
            cat "$tmp"
        } >> "$file"
    fi
    rm -f "$tmp"
    pm_env_reconcile_memory_surfaces "$file"
}

pm_env_reconcile_memory_surfaces() {
    local file="${1:?env file required}"
    local deployment mode personal_enabled default_surface personal_api

    deployment="$(pm_env_get DEPLOYMENT_MODE server "$file")"
    mode="$(pm_env_get PM_MEMORY_INSTALL_MODE "" "$file")"
    personal_enabled="$(pm_env_get PM_PERSONAL_MEMORY_ENABLED "" "$file")"
    default_surface="$(pm_env_get PM_DEFAULT_MEMORY_SURFACE "" "$file")"
    personal_api="$(pm_env_get PM_PERSONAL_API_URL "" "$file")"

    if [ "$deployment" = "local" ]; then
        [ "$personal_enabled" = "true" ] || pm_env_put PM_PERSONAL_MEMORY_ENABLED true "$file"
        if [ "$mode" != "personal-and-shared" ]; then
            pm_env_put PM_MEMORY_INSTALL_MODE personal-only "$file"
        fi
        [ "$default_surface" = "personal" ] || pm_env_put PM_DEFAULT_MEMORY_SURFACE personal "$file"
        [ -n "$personal_api" ] || pm_env_put PM_PERSONAL_API_URL http://localhost:8090 "$file"
        return 0
    fi

    [ -n "$personal_enabled" ] || pm_env_put PM_PERSONAL_MEMORY_ENABLED false "$file"
    [ -n "$mode" ] || pm_env_put PM_MEMORY_INSTALL_MODE shared-only "$file"
    [ -n "$default_surface" ] || pm_env_put PM_DEFAULT_MEMORY_SURFACE shared "$file"
    [ -n "$personal_api" ] || pm_env_put PM_PERSONAL_API_URL http://localhost:8090 "$file"
}

pm_env_ensure_database_urls() {
    local file="${1:?env file required}"
    local postgres_user postgres_password postgres_db pm_app_password database_url migrate_url

    postgres_user="$(pm_env_get POSTGRES_USER pmuser "$file")"
    postgres_password="$(pm_env_get POSTGRES_PASSWORD "" "$file")"
    postgres_db="$(pm_env_get POSTGRES_DB persistent_memory "$file")"
    pm_app_password="$(pm_env_get PM_APP_PASSWORD "" "$file")"

    if [ -n "$pm_app_password" ]; then
        database_url="$(pm_env_get DATABASE_URL "" "$file")"
        if [ -z "$database_url" ]; then
            pm_env_put DATABASE_URL "postgresql://pm_app:${pm_app_password}@persistent-memory-postgres:5432/${postgres_db}" "$file"
        fi
    fi

    if [ -n "$postgres_password" ]; then
        migrate_url="$(pm_env_get DATABASE_MIGRATE_URL "" "$file")"
        if [ -z "$migrate_url" ]; then
            pm_env_put DATABASE_MIGRATE_URL "postgresql://${postgres_user}:${postgres_password}@persistent-memory-postgres:5432/${postgres_db}" "$file"
        fi
    fi
}

pm_env_generate_core_secrets() {
    local file="${1:?env file required}"
    local changed=0

    if pm_env_ensure_generated_secret TOKEN_PEPPER "$file" 43; then changed=1; fi
    if pm_env_ensure_generated_secret POSTGRES_PASSWORD "$file" 36; then changed=1; fi
    if pm_env_ensure_generated_secret PM_APP_PASSWORD "$file" 36; then changed=1; fi
    if pm_env_ensure_generated_secret MINIO_ROOT_PASSWORD "$file" 36; then changed=1; fi
    if pm_env_ensure_generated_secret FALKORDB_PASSWORD "$file" 36; then changed=1; fi
    if pm_env_ensure_generated_secret QDRANT_API_KEY "$file" 40; then changed=1; fi
    if pm_env_ensure_generated_secret DOCKER_CONTROL_TOKEN "$file" 32; then changed=1; fi
    if pm_env_ensure_generated_secret UPDATE_RUNNER_TOKEN "$file" 32; then changed=1; fi
    if pm_env_ensure_generated_secret USAGE_INGEST_TOKEN "$file" 32; then changed=1; fi
    pm_env_ensure_database_urls "$file"
    return 0
}

pm_env_validate_deploy_required() {
    local file="${1:?env file required}"
    local missing=()
    local key value graph extraction embed

    for key in \
        TOKEN_PEPPER PM_HOST_BIND OLLAMA_URL EMBED_PROVIDER EMBED_MODEL EMBED_DIM EMBEDDING_MODE \
        EXTRACTION_PROVIDER EXTRACTION_MODEL GRAPH_BACKEND SEMAPHORE_LIMIT QDRANT_URL QDRANT_API_KEY \
        POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB PM_APP_PASSWORD DATABASE_URL DATABASE_MIGRATE_URL \
        REDIS_URL MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_ENDPOINT GRAPHITI_URL API_PORT DEPLOYMENT_MODE \
        ARGON2_MEMORY_KIB ARGON2_TIME_COST ARGON2_PARALLELISM PM_MCP_RUNTIME PM_PERSONAL_MEMORY_ENABLED \
        PM_MEMORY_INSTALL_MODE PM_DEFAULT_MEMORY_SURFACE DOCKER_CONTROL_TOKEN \
        UPDATE_RUNNER_TOKEN USAGE_INGEST_TOKEN
    do
        value="$(pm_env_get "$key" "" "$file")"
        [ -n "$value" ] || missing+=("$key")
    done

    if [ "$(pm_env_get PM_MCP_RUNTIME node "$file")" = "stream" ] && [ -z "$(pm_env_get PM_MCP_STREAM_URL "" "$file")" ]; then
        missing+=("PM_MCP_STREAM_URL")
    fi
    if [ "$(pm_env_get PM_PERSONAL_MEMORY_ENABLED false "$file")" = "true" ] && [ -z "$(pm_env_get PM_PERSONAL_API_URL "" "$file")" ]; then
        missing+=("PM_PERSONAL_API_URL")
    fi
    if [ "$(pm_env_get PM_MEMORY_INSTALL_MODE shared-only "$file")" = "personal-and-shared" ]; then
        [ -n "$(pm_env_get PM_SHARED_API_URL "" "$file")" ] || missing+=("PM_SHARED_API_URL")
        [ -n "$(pm_env_get PM_SHARED_USER_TOKEN "" "$file")" ] || missing+=("PM_SHARED_USER_TOKEN")
    fi

    graph="$(pm_env_get GRAPH_BACKEND "" "$file")"
    if [ "$graph" = "falkordb" ]; then
        for key in FALKORDB_HOST FALKORDB_PORT FALKORDB_PASSWORD; do
            [ -n "$(pm_env_get "$key" "" "$file")" ] || missing+=("$key")
        done
    elif [ "$graph" = "neo4j" ]; then
        for key in NEO4J_URI NEO4J_USER NEO4J_PASSWORD NEO4J_AUTH; do
            [ -n "$(pm_env_get "$key" "" "$file")" ] || missing+=("$key")
        done
    fi

    extraction="$(pm_env_get EXTRACTION_PROVIDER "" "$file")"
    if [ "$extraction" = "anthropic" ] && [ -z "$(pm_env_get ANTHROPIC_API_KEY "" "$file")" ]; then missing+=("ANTHROPIC_API_KEY"); fi
    if [ "$extraction" = "openai" ] && [ -z "$(pm_env_get OPENAI_API_KEY "" "$file")" ]; then missing+=("OPENAI_API_KEY"); fi

    embed="$(pm_env_get EMBED_PROVIDER "" "$file")"
    if [ "$embed" = "voyage" ] && [ -z "$(pm_env_get VOYAGE_API_KEY "" "$file")" ]; then missing+=("VOYAGE_API_KEY"); fi
    if [ "$embed" = "openai" ] && [ -z "$(pm_env_get OPENAI_API_KEY "" "$file")" ]; then missing+=("OPENAI_API_KEY"); fi

    if [ "${#missing[@]}" -gt 0 ]; then
        printf 'Missing required env value(s): %s\n' "${missing[*]}" >&2
        return 1
    fi
    return 0
}
