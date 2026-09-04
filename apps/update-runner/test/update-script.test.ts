import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('terminal update script', () => {
  function lockfileAllowlist(script: string): RegExp {
    const match = script.match(/grep -E '([^']+)'/)
    const pattern = match?.[1]
    expect(pattern).toBeTruthy()
    if (!pattern) throw new Error('Could not find update lockfile allowlist pattern')
    return new RegExp(pattern)
  }

  function classifyDirtyPaths(script: string, porcelain: string): { lockDirty: string[]; nonLockDirty: string[] } {
    const allow = lockfileAllowlist(script)
    const dirtyPaths = porcelain
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3))
    return {
      lockDirty: dirtyPaths.filter((path) => allow.test(path)),
      nonLockDirty: dirtyPaths.filter((path) => !allow.test(path)),
    }
  }

  function normalizeRuntimeHandoffStateDir(configuredDir: string): string {
    return execFileSync(
      'bash',
      ['-c', 'source "$1"; pm_normalize_handoff_state_dir "$2" "$3"', '_', 'deploy/scripts/lib/update-handoff-state.sh', '/runtime/source', configuredDir],
      { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' },
    ).trim()
  }

  it('preserves generated lockfile drift before the fast-forward merge', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')
    const pullStart = script.indexOf('incoming=$(git log --oneline "HEAD..origin/$branch"')
    const pullEnd = script.indexOf('ok "Updated to latest origin/$branch."')
    expect(pullStart).toBeGreaterThan(-1)
    expect(pullEnd).toBeGreaterThan(pullStart)
    const pullBlock = script.slice(
      pullStart,
      pullEnd,
    )

    expect(script).toContain('ensure_tracked_worktree_safe_for_update_merge()')
    expect(script).toContain('git stash push -m "$stash_name" -- package-lock.json apps/dashboard/package-lock.json')
    expect(script).toContain('Generated lockfile drift is auto-stashed only when it is the only tracked change.')
    expect(pullBlock).toContain('ensure_tracked_worktree_safe_for_update_merge')
    expect(pullBlock.indexOf('ensure_tracked_worktree_safe_for_update_merge')).toBeLessThan(
      pullBlock.indexOf('git merge --ff-only "origin/$branch"'),
    )
  })

  it('classifies only root and dashboard lockfile drift as auto-stashable', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(classifyDirtyPaths(script, ' M package-lock.json')).toEqual({
      lockDirty: ['package-lock.json'],
      nonLockDirty: [],
    })
    expect(classifyDirtyPaths(script, ' M apps/dashboard/package-lock.json')).toEqual({
      lockDirty: ['apps/dashboard/package-lock.json'],
      nonLockDirty: [],
    })
    expect(classifyDirtyPaths(script, ' M package-lock.json\n M apps/dashboard/package-lock.json')).toEqual({
      lockDirty: ['package-lock.json', 'apps/dashboard/package-lock.json'],
      nonLockDirty: [],
    })
    expect(classifyDirtyPaths(script, ' M package-lock.json\n M README.md')).toEqual({
      lockDirty: ['package-lock.json'],
      nonLockDirty: ['README.md'],
    })
    expect(classifyDirtyPaths(script, ' M admin/package-lock.json')).toEqual({
      lockDirty: [],
      nonLockDirty: ['admin/package-lock.json'],
    })
  })

  it('runs Prisma migrate from the moved schema layer', async () => {
    const source = await readFile(new URL('../../../layers/update-ops/update-flow/update.ts', import.meta.url), 'utf8')

    expect(source).toContain("join(cfg.repoDir, 'layers/core/schema')")
    expect(source).not.toContain("join(cfg.repoDir, 'prisma')")
  })

  it('supports an exact release through a named detached worktree', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('UPDATE_RELEASE_OVERRIDE')
    expect(script).toContain('--release)')
    expect(script).toContain('--release requires a semantic version.')
    expect(script).toContain('validate_update_release')
    expect(script).toContain('resolve_release_worktree')
    expect(script).toContain('persistent-memory-${UPDATE_RELEASE_OVERRIDE}')
    expect(script).toContain('persistent-memory-${UPDATE_RELEASE_OVERRIDE}-${commit:0:12}')
    expect(script).toContain('git worktree add --detach')
    expect(script).toContain('Refusing to replace it automatically')
    expect(script).toContain('VERSIONED_WORKTREE=1')
    const markerWriter = script.slice(script.indexOf('mark_update_complete()'), script.indexOf('wait_for_dashboard_ready()'))
    expect(markerWriter).toContain('branch="$UPDATE_BRANCH_OVERRIDE"')
  })

  it('keeps the gateway legacy handoff mount separate from coordinator-owned state', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')
    const compose = await readFile(new URL('../../../deploy/compose/docker-compose.yml', import.meta.url), 'utf8')

    expect(script).toContain('LEGACY_HANDOFF_STATE_DIR="$(pm_normalize_handoff_state_dir "$SOURCE_REPO_ROOT" "${PM_LEGACY_HANDOFF_STATE_DIR:-}")"')
    expect(script).toContain('RUNTIME_HANDOFF_STATE_DIR="$(pm_normalize_handoff_state_dir "$SOURCE_REPO_ROOT" "${PM_HANDOFF_STATE_DIR:-$LEGACY_HANDOFF_STATE_DIR}")"')
    expect(script).toContain('HANDOFF_STATE_DIR="$RUNTIME_HANDOFF_STATE_DIR"')
    expect(script).toContain('DEPLOYED_STATE_DIR="${PM_COORDINATOR_DEPLOYED_STATE_DIR:-$RUNTIME_HANDOFF_STATE_DIR}"')
    expect(script).toContain('state_dir="$DEPLOYED_STATE_DIR"')
    expect(script).not.toContain('HANDOFF_STATE_DIR="$REPO_ROOT/.local/update-state"')
    expect(script).toContain('PM_LEGACY_HANDOFF_STATE_DIR="$LEGACY_HANDOFF_STATE_DIR"')
    expect(script).toContain('PM_HANDOFF_STATE_DIR="$RUNTIME_HANDOFF_STATE_DIR"\nexport PM_LEGACY_HANDOFF_STATE_DIR PM_HANDOFF_STATE_DIR')
    expect(script).toContain('PM_LEGACY_HANDOFF_STATE_DIR="$LEGACY_HANDOFF_STATE_DIR"')
    expect(script).toContain('ensure_dashboard_gateway_handoff_mount')
    expect(script).toContain('PM_COORDINATOR_STATE_DIR="$COORDINATOR_INSTALLATION_HOME/state"\nexport PM_COORDINATOR_STATE_DIR\nensure_dashboard_gateway_handoff_mount')
    expect(compose).toContain('${PM_LEGACY_HANDOFF_STATE_DIR:-../../.local/update-state}:/run/persistent-memory/update-state:ro')
  })

  it('keeps the first coordinator milestone ahead of the launcher source-resolution milestone', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('dashboard_handoff_write "updating" "Pulling Persistent Memory updates from origin/$branch." "" "18"')
    expect(script).toContain('dashboard_handoff_write "updating" "Checking local service secrets." "" "20"')
  })

  it('publishes the fetched remote release version before the 18% update handoff', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')
    const fetch = script.indexOf('if ! git_fetch_origin_branch "$branch"; then')
    const targetVersion = script.indexOf('HANDOFF_TARGET_VERSION_OVERRIDE="$(release_at_commit "origin/$branch")"')
    const handoff = script.indexOf('dashboard_handoff_write "updating" "Pulling Persistent Memory updates from origin/$branch." "" "18"')

    expect(fetch).toBeGreaterThan(-1)
    expect(targetVersion).toBeGreaterThan(fetch)
    expect(handoff).toBeGreaterThan(targetVersion)
    expect(script).toContain('target_version="${HANDOFF_TARGET_VERSION_OVERRIDE:-$(current_package_version)}"')
  })

  it('counts Graph V2 progress with the worker’s exact derived-partition predicate', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('worker node dist/graph-v2-progress-cli.js')
    expect(script).not.toContain("graph_group_id LIKE 'pmg:v2:%'")
    expect(script).not.toContain("graph_status = 'ok' AND graph_group_id IS NOT NULL")
  })

  it('normalizes unset and relative handoff paths before exporting them to Compose', () => {
    expect(normalizeRuntimeHandoffStateDir('')).toBe('/runtime/source/.local/update-state')
    expect(normalizeRuntimeHandoffStateDir('.local/alternate-state')).toBe('/runtime/source/.local/alternate-state')
    expect(normalizeRuntimeHandoffStateDir('/var/lib/persistent-memory/update-state')).toBe('/var/lib/persistent-memory/update-state')
  })

  it('signals the gateway before coordinator-owned snapshot work starts', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')
    const updateStart = script.indexOf('dashboard_handoff_write "updating" "Preparing a safe update snapshot." "" "5"')
    const handoffWait = script.indexOf('wait_for_dashboard_handoff', updateStart)

    expect(updateStart).toBeGreaterThan(-1)
    expect(handoffWait).toBeGreaterThan(updateStart)
    expect(script).not.toContain('snapshot_before_update')
    expect(script).toContain('Dashboard gateway received the update handoff; allowing open tabs to switch screens.')
  })

  it('does not resolve an exact-release worktree before the initial gateway handoff', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')
    const firstHandoff = script.indexOf('dashboard_handoff_write "updating" "Preparing a safe update snapshot." "" "5"')
    const worktreeResolution = script.lastIndexOf('resolve_release_worktree')

    expect(firstHandoff).toBeGreaterThan(-1)
    expect(worktreeResolution).toBeGreaterThan(firstHandoff)
  })

  it('uses master as the safe default source for an exact release and rejects conflicting shortcuts', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('UPDATE_RELEASE_BRANCH_EXPLICIT=0')
    expect(script).toContain('UPDATE_BRANCH_OVERRIDE="master"')
    expect(script).toContain('--release cannot be combined with --dev or --master.')
    expect(script).toContain('--release can only be combined with one explicit --branch.')
    expect(script).toContain('Using exact release ${UPDATE_RELEASE_OVERRIDE} from origin/${UPDATE_BRANCH_OVERRIDE}.')
    expect(script).not.toContain('--version)')
  })

  it('does not retain a local-only updater mode in the product command surface', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).not.toContain('local-source')
    expect(script).not.toContain('LOCAL_SOURCE_UPDATE')
  })

  it('builds application images before deploying them without an opaque main compose rebuild', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('compose_build_with_handoff "application images" "55" "73"')
    expect(script).toContain('"${COMPOSE[@]}" up -d --no-build "${UPDATE_RECREATE_SERVICES[@]}"')
    expect(script).not.toContain('"${COMPOSE[@]}" up -d --build "${UPDATE_RECREATE_SERVICES[@]}"')
    expect(script.indexOf('compose_build_with_handoff "application images" "55" "73"')).toBeLessThan(
      script.indexOf('"${COMPOSE[@]}" up -d --no-build "${UPDATE_RECREATE_SERVICES[@]}"'),
    )
  })

  it('advances the numeric handoff progress when active setup and build details change', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('progress="${7:-}"')
    expect(script).toContain('dashboard_handoff_write "$handoff_phase" "$message" "" "$progress"')
    expect(script).toContain('progress=$((31 + elapsed / heartbeat_seconds))')
    expect(script).toContain('if [ "$progress" -lt 44 ]; then')
    expect(script).toContain('"Dependencies and generated clients are ready." "44"')
    expect(script).toContain('compose_build_with_handoff "dashboard gateway" "46" "52" dashboard-gateway')
    expect(script).toContain('compose_build_with_handoff "application images" "55" "73" "${UPDATE_RECREATE_SERVICES[@]}"')
    expect(script).toContain('if [ "$progress" -lt "$end_progress" ]; then')
  })

  it('keeps the terminal build stream while publishing bounded, safe build activity heartbeats', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('dashboard_handoff_activity "rebuilding-dashboard" "build" "running" "$label"')
    expect(script).toContain('dashboard_handoff_activity "updating" "setup" "running" "update dependencies"')
    expect(script).toContain('Follow the terminal for the complete live build log.')
    const activityHelpers = script.slice(script.indexOf('run_setup_with_handoff()'), script.indexOf('mark_update_complete()'))
    expect(activityHelpers).toContain('PM_UPDATE_BUILD_HEARTBEAT_SECONDS')
    expect(activityHelpers).toContain('sleep 1')
    expect(script).toContain('"${COMPOSE[@]}" build "${services[@]}" &')
    expect(script).toContain('dashboard_handoff_activity "rebuilding-dashboard" "build" "failed" "$label"')
  })

  it('publishes a safe, phase-specific failure detail to the dashboard handoff', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('set -Eeuo pipefail')
    expect(script).toContain('HANDOFF_FAILURE_DETAIL=""')
    expect(script).toContain('dashboard_handoff_record_error()')
    expect(script).toContain('trap dashboard_handoff_record_error ERR')
    expect(script).toContain('Update failed during ${HANDOFF_PHASE:-update}. Review the error below, then use the terminal for full details.')
    expect(script).toContain('"${HANDOFF_FAILURE_DETAIL:-Update command failed with exit code $code during ${HANDOFF_PHASE:-update}.}"')
  })

  it('does not ship an unused Prisma CLI in the update-runner runtime image', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(manifest.dependencies?.prisma).toBeUndefined()
  })

  it('routes coordinator-capable updates through an installed external coordinator while preserving the legacy child path', async () => {
    const [script, rootPackage, compose] = await Promise.all([
      readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8'),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../deploy/compose/docker-compose.yml', import.meta.url), 'utf8'),
    ])

    expect(script).toContain('PM_COORDINATOR_ACTIVE')
    expect(script).toContain('scripts/install-update-coordinator.mjs')
    expect(script).toContain('exec node "$COORDINATOR_HOME/coordinator.mjs"')
    expect(script).toContain('PM_COORDINATOR_INSTALL_ROOT')
    expect(script).toContain('PM_COORDINATOR_STATE_DIR')
    expect(script).toContain('PM_COORDINATOR_TARGET_RESOLVED')
    expect(script.indexOf('COORDINATOR_HOME=')).toBeGreaterThan(script.lastIndexOf('resolve_release_worktree'))
    expect(script).toContain('PM_COORDINATOR_RESOLVED_ROOT')
    expect(script).toContain('PM_COORDINATOR_VERSIONED_WORKTREE')
    expect(script).toContain('node "$SOURCE_REPO_ROOT/scripts/install-update-coordinator.mjs" --root "$SOURCE_REPO_ROOT" --print-home')
    expect(script).not.toContain('node "$REPO_ROOT/scripts/install-update-coordinator.mjs" --root "$SOURCE_REPO_ROOT" --print-home')
    expect(script).toContain('reserve_coordinator_before_source_resolution')
    expect(script.indexOf('reserve_coordinator_before_source_resolution\nPM_COORDINATOR_STATE_DIR="$COORDINATOR_INSTALLATION_HOME/state"\nexport PM_COORDINATOR_STATE_DIR\nensure_dashboard_gateway_handoff_mount\nsection "persistent-memory — update"')).toBeGreaterThan(-1)
    expect(script).toContain('--legacy-script "$SCRIPT_REPO_ROOT/deploy/scripts/update.sh"')
    expect(compose).toContain('${PM_COORDINATOR_STATE_DIR:-../../.local/update-coordinator-state}:/run/persistent-memory/update-coordinator-state:ro')
    expect(rootPackage).toContain('npm run build:update-coordinator')
    expect(rootPackage).toContain('node scripts/install-update-coordinator.mjs')
  })

  it('keeps the initiating environment and browser handoff through coordinator bridge hops', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('ENV_RUNTIME="${PM_COORDINATOR_ENV_RUNTIME:-$REPO_ROOT/.env.persistent-memory}"')
    expect(script).toContain('HANDOFF_RUN_ID="${PM_HANDOFF_ID:-$(date -u +"%Y%m%dT%H%M%SZ")-$$}"')
    expect(script).toContain('PM_COORDINATOR_BRANCH')
    expect(script).not.toContain('PM_COORDINATOR_SNAPSHOT_READY=1')
    expect(script).toContain('PM_COORDINATOR_FINAL_HOP')
    expect(script).toContain('Bridge release ${version} is verified. Continuing to the next required release.')
  })

  it('runs the resumable Graph V2 migration only after the protected updater snapshot and database migration', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')
    const migrate = script.indexOf('Migrations applied (prisma migrate deploy).')
    const graph = script.lastIndexOf('run_graph_v2_migration_with_probe')
    const verify = script.indexOf('Running installation verification.')
    expect(graph).toBeGreaterThan(migrate)
    expect(graph).toBeLessThan(verify)
    expect(script).toContain('node dist/graph-v2-migration-cli.js --snapshot-id="$HANDOFF_RUN_ID"')
  })

  it('adds a reusable non-fatal progress probe around the Graph V2 migration', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('run_progress_probe()')
    expect(script).toContain('stop_progress_probe()')
    expect(script).toContain('PM_UPDATE_PROGRESS_PROBE_SECONDS:-60')
    expect(script).toContain('sleep "$interval"')
    expect(script).toContain('progress check failed; the update continues')
    expect(script).toContain('graph_v2_progress_probe()')
    expect(script).toContain('worker node dist/graph-v2-progress-cli.js')
    expect(script).toContain('run_progress_probe "graph migration" "verifying" "87" "Rebuilding and validating project-scoped graph partitions." graph_v2_progress_probe')
    expect(script).toContain('stop_progress_probe\n        return 0')
    expect(script).toContain('stop_progress_probe\n    release_coordinator_reservation')
  })

  it('gives FalkorDB bounded Graphiti full-text reads a realistic persistent timeout', async () => {
    const [compose, envTemplate] = await Promise.all([
      readFile(new URL('../../../deploy/compose/docker-compose.yml', import.meta.url), 'utf8'),
      readFile(new URL('../../../.env.persistent-memory.example', import.meta.url), 'utf8'),
    ])

    expect(compose).toContain('FALKORDB_ARGS: "TIMEOUT ${FALKORDB_QUERY_TIMEOUT_MS:-5000}"')
    expect(envTemplate).toContain('FALKORDB_QUERY_TIMEOUT_MS=5000')
  })
})
