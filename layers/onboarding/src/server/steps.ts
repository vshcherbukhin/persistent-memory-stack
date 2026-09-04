/**
 * persistent-memory-onboard — the ordered install step list + output parsers.
 *
 * Drives the INDIVIDUAL proven commands install.sh runs (not `./install.sh` as one
 * opaque step) so the UI shows granular per-step progress. Prisma/seed run on the
 * HOST, so DATABASE_MIGRATE_URL must target the host port (localhost:5433), not
 * the container hostname. RLS is applied through the Postgres container's psql.
 *
 * buildSteps is pure (testable); install.ts spawns each step and streams output.
 */

/** In-process steps the orchestrator runs itself (no child process). */
export type FnId = 'register' | 'write-rule' | 'shared-connect'

export interface InstallStep {
  id: string
  name: string
  /** argv (spawned WITHOUT a shell — no interpolation). Empty `[]` for 'fn' steps. */
  cmd: string[]
  /** cwd relative to the repo root ('' = root). */
  cwd: string
  /** env vars to ADD/override for this step (merged over the loaded .env). */
  envOverride?: Record<string, string>
  /** 'wait' = poll until ready; 'fn' = orchestrator runs it in-process; 'ollama-model' = pull iff missing; 'cleanup' = best-effort command. */
  kind: 'run' | 'wait' | 'fn' | 'ollama-model' | 'cleanup'
  /** capture the bootstrap token from this step's stdout. */
  captureToken?: boolean
  /** the in-process handler to dispatch when kind === 'fn'. */
  fnId?: FnId
}

/** Rewrite a container-host DB URL to the host port (install.sh parity). */
export function hostRewriteUrl(url: string): string {
  return url.replace('persistent-memory-postgres:5432', 'localhost:5433')
}

export interface BuildStepsInput {
  /** Which installation flow the wizard routed to. */
  flow: 'full' | 'engine' | 'mcp'
  /** The parsed .env (full flow only; at least DATABASE_MIGRATE_URL + PM_APP_PASSWORD). */
  env?: Record<string, string>
  /** @deprecated Node is a migration alias. Stream MCP is the only runtime. */
  mcpRuntime?: 'stream' | 'node'
  /** Engine flow: the server-pinned model to pull locally. */
  pullModel?: string
  /** Client flows with isolated personal memory also install a local private stack. */
  personalMemoryEnabled?: boolean
  /** Shared-only stream MCP: remote API URL to bake into the user-side stream container. */
  streamApiUrl?: string
  /** Shared-only stream MCP: admin-issued user token stored only in the stream container env. */
  streamToken?: string
  /** Shared-only client-managed embeddings stream MCP: host Ollama URL to expose to the stream container. */
  streamOllamaUrl?: string
  /** Personal-first installs can save a shared connector after local verify. */
  memoryInstallMode?: 'shared-only' | 'personal-only' | 'personal-and-shared'
}

const REGISTER_STEP: InstallStep = {
  id: 'register', name: 'Register the MCP with your agent app(s)', cmd: [], cwd: '', kind: 'fn', fnId: 'register',
}
const RULE_STEP: InstallStep = {
  id: 'write-rule', name: 'Write the memory-usage rule + top memory block', cmd: [], cwd: '', kind: 'fn', fnId: 'write-rule',
}
const SHARED_CONNECT_STEP: InstallStep = {
  id: 'shared-connect', name: 'Save the Shared Memories connection', cmd: [], cwd: '', kind: 'fn', fnId: 'shared-connect',
}
const COMPOSE_ENV_ARGS = ['docker', 'compose', '-f', 'deploy/compose/docker-compose.yml', '--env-file', '.env.persistent-memory'] as const

/** The full local-server install: the proven 8 host-side commands. */
function fullStackSteps(env: Record<string, string>): InstallStep[] {
  const dbEnv: Record<string, string> = { DATABASE_MIGRATE_URL: hostRewriteUrl(env.DATABASE_MIGRATE_URL ?? '') }
  const composeBuildEnv: Record<string, string> = { COMPOSE_PARALLEL_LIMIT: '1', COMPOSE_PROFILES: 'mcp-stream' }
  // Local mode = no auth → the seed mints no bootstrap token (nothing to capture/show).
  const local = env.DEPLOYMENT_MODE === 'local'
  const steps: InstallStep[] = [
    {
      // Makes the single `npm run install-persistent-memory` self-contained: installs
      // the workspace deps + generates the Prisma client the host-side seed imports
      // (no postinstall hook does this). `npm run setup` runs through a shell so the
      // `&&` chain works even though steps are spawned without one.
      id: 'deps', name: 'Install dependencies + generate the Prisma client', cmd: ['npm', 'run', 'setup'], cwd: '', kind: 'run',
    },
  ]
  if ((env.EMBED_PROVIDER ?? 'ollama') === 'ollama' && env.EMBED_MODEL) {
    steps.push({
      id: 'pull-model',
      name: `Ensure Ollama model is installed (${env.EMBED_MODEL})`,
      cmd: ['ollama', 'pull', env.EMBED_MODEL],
      cwd: '',
      kind: 'ollama-model',
    })
  }
  steps.push(
    // --build so the installer runs the repo's CURRENT code (a stale prebuilt image would ship old
    // server code). The api may boot before migrate on a fresh DB — it's best-effort there (in local
    // mode) and is force-recreated post-migrate by restart-app.
    { id: 'compose-up', name: 'Build images + start storage + app services (docker compose up --build)', cmd: [...COMPOSE_ENV_ARGS, 'up', '-d', '--build'], cwd: '', kind: 'run', envOverride: composeBuildEnv },
    { id: 'wait-postgres', name: 'Wait for Postgres to be healthy', cmd: ['docker', 'inspect', '-f', '{{.State.Health.Status}}', 'persistent-memory-postgres'], cwd: '', kind: 'wait' },
    { id: 'prisma-migrate', name: 'Apply database migrations (Prisma)', cmd: ['npm', 'run', '--silent', 'migrate:deploy'], cwd: 'layers/core/schema', envOverride: dbEnv, kind: 'run' },
    {
      id: 'rls', name: 'Apply Row-Level Security + the pm_app role', cmd: ['bash', 'deploy/scripts/apply-rls.sh'], cwd: '',
      // rls.sql reads PM_APP_PASSWORD via PGOPTIONS inside deploy/scripts/apply-rls.sh.
      envOverride: { ...dbEnv, PM_APP_PASSWORD: env.PM_APP_PASSWORD ?? 'pmapp' }, kind: 'run',
    },
    { id: 'seed', name: local ? 'Seed system settings + demo teams' : 'Seed the bootstrap super-admin (shows the token once)', cmd: ['npm', 'run', '--silent', 'seed'], cwd: 'layers/core/schema', envOverride: dbEnv, kind: 'run', captureToken: !local },
    // --force-recreate so the api/worker RE-BOOT now the schema + pm_app role exist: this is when
    // local mode's ensureLocalIdentity actually creates the local super-user (plain `up -d` would be
    // a no-op if the container is already running, and the user would never be created).
    { id: 'restart-app', name: 'Start the API + worker as pm_app', cmd: [...COMPOSE_ENV_ARGS, 'up', '-d', '--force-recreate', '--no-deps', 'api', 'worker'], cwd: '', kind: 'run' },
    { id: 'wait-mcp', name: 'Wait for stream MCP to be healthy', cmd: ['docker', 'inspect', '-f', '{{.State.Health.Status}}', 'persistent-memory-mcp'], cwd: '', kind: 'wait' },
    { id: 'verify', name: 'Verify the install', cmd: ['bash', 'deploy/scripts/verify-install.sh'], cwd: '', kind: 'run' },
  )
  return steps
}

/**
 * The ordered steps for the chosen flow. Full = the local-server install then
 * register + rule. Client flows (engine/mcp) skip the stack entirely: optionally
 * build the MCP image (docker launch), pull the server's pinned model (engine
 * only), then register + write the rule. register/write-rule are 'fn' steps the
 * orchestrator runs in-process (see install.ts).
 */
export function buildSteps(input: BuildStepsInput): InstallStep[] {
  const steps = fullStackSteps(input.env ?? {})
  if (input.memoryInstallMode === 'personal-and-shared') {
    if (input.pullModel) {
      steps.push({
        id: 'pull-shared-model',
        name: `Ensure shared server embedding model is installed (${input.pullModel})`,
        cmd: ['ollama', 'pull', input.pullModel],
        cwd: '',
        kind: 'ollama-model',
      })
    }
    steps.push(SHARED_CONNECT_STEP)
  }
  return [...steps, REGISTER_STEP, RULE_STEP]
}

/**
 * Capture the show-once bootstrap token from the seed step's stdout.
 * Returns { token } when minted, { already: true } when a superuser already
 * existed (the seed skips minting), or null when neither line is present yet.
 */
export function extractToken(stdout: string): { token: string } | { already: true } | null {
  const m = /^\s*Token:\s+(\S+\.\S+)\s*$/m.exec(stdout)
  if (m) return { token: m[1]! }
  if (/Superuser already present/i.test(stdout)) return { already: true }
  return null
}

export interface VerifySummary {
  pass: number
  fail: number
  warn: number
}

/** Parse the verify-install.sh tail into PASS/FAIL/WARN counts (best-effort). */
export function parseVerifySummary(stdout: string): VerifySummary {
  const count = (re: RegExp) => (stdout.match(re) ?? []).length
  return {
    pass: count(/\b(PASS|OK|✓)\b/g),
    fail: count(/\b(FAIL|ERROR|✗)\b/g),
    warn: count(/\b(WARN|WARNING)\b/g),
  }
}
