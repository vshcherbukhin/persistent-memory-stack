/**
 * persistent-memory-onboard — the local installer server.
 *
 * SECURITY: binds 127.0.0.1 ONLY (loopback, single-user desktop). It deliberately
 * runs privileged install commands (brew/docker/npm) on the user's machine — that
 * is its job — and is single-use + self-terminating. It MUST NOT be containerized
 * or shipped to the server. Secrets (token, passwords) live in memory + the .env
 * file the stack already needs; masked in every preview.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { renderEnv, maskEnv, genSecrets, validateEnvForDeploy, type Answers } from './env.js'
import {
  buildPrereqInstallPlan,
  parseCommandPresence,
  parseDockerInfo,
  parseComposeVersion,
  parseNodeVersion,
  parseOllamaTags,
  hasModel,
  homebrewManualInstallCommands,
  type PrereqComponent,
  type PrereqInstallStep,
} from './prereq.js'
import { runInstall, parseEnvFile, type InstallEvent, type WizardPayload } from './install.js'
import { readSpecs, readApps } from './detect.js'
import { readDefaultRule, defaultMemoryBlock } from './rule.js'
import { originGuardReason } from './guard.js'
import { testExtractionConnection, type ExtractionProvider } from './extraction-test.js'

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.ONBOARD_PORT ?? 4319)
const PM_ROOT = process.env.PM_ROOT ?? process.cwd()
const API_URL = process.env.API_URL ?? 'http://localhost:8090'
const DEFAULT_DASHBOARD_URL = 'http://localhost:3200'
const ENV_PATH = join(PM_ROOT, '.env.persistent-memory')
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'

// In-memory only — the captured bootstrap token (shown once; never persisted).
let bootstrapToken: string | null = null
const dashboardUrl = process.env.DASHBOARD_URL ?? process.env.ADMIN_URL ?? DEFAULT_DASHBOARD_URL

const app = Fastify({ logger: false })

// ── DNS-rebinding guard (loopback-only; privileged install endpoints) ────────────
// Applies to /api/* only — /healthz and static assets are exempt. Rejects any
// request whose Host is not loopback:<PORT>, and any POST carrying a foreign Origin.
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api')) return
  const reason = originGuardReason(req.method, req.headers.host, req.headers.origin, PORT)
  if (reason) return reply.code(403).send({ error: reason })
})

function execCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    child.stderr.on('data', (b: Buffer) => (stdout += b.toString()))
    child.on('error', () => resolve({ code: 1, stdout }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
}

async function detectBrewPath(): Promise<string | null> {
  const which = await execCapture('which', ['brew'])
  if (which.code === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0] ?? null
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(p)) return p
  }
  return null
}

async function brewEnv(): Promise<NodeJS.ProcessEnv> {
  const brew = await detectBrewPath()
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!brew) return env
  const out = await execCapture(brew, ['shellenv'])
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = /^export\s+([A-Z0-9_]+)="?([^";]+)"?;?$/.exec(line.trim())
    if (m) env[m[1]!] = m[2]!
  }
  env.PATH = [dirname(brew), env.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(':')
  Object.assign(process.env, env)
  return env
}

async function prereqState() {
  const [brewPath, dockerVersion, docker, compose, node, ollamaWhich, ollamaTags] = await Promise.all([
    detectBrewPath(),
    execCapture('docker', ['--version']),
    execCapture('docker', ['info']),
    execCapture('docker', ['compose', 'version']),
    execCapture('node', ['-v']),
    execCapture('which', ['ollama']),
    fetch(`${OLLAMA_URL}/api/tags`).then((r) => r.json()).catch(() => null),
  ])
  const models = parseOllamaTags(ollamaTags)
  const dockerInstalled = dockerVersion.code === 0
  const dockerInfo = parseDockerInfo(docker.stdout, docker.code)
  const ollamaPresence = parseCommandPresence('Ollama', ollamaWhich.stdout, ollamaWhich.code)
  const ollamaInstalled = !!ollamaPresence.installed
  const ollamaRunning = ollamaTags !== null
  return {
    homebrew: {
      ok: process.platform === 'darwin' ? !!brewPath : true,
      installed: !!brewPath,
      path: brewPath,
      detail: process.platform === 'darwin'
        ? brewPath ? `Homebrew found at ${brewPath}.` : 'Homebrew not found.'
        : 'Homebrew not required on this platform.',
      manualInstall: process.platform === 'darwin' && !brewPath
        ? homebrewManualInstallCommands(process.arch)
        : null,
    },
    docker: {
      ...dockerInfo,
      ok: dockerInstalled && dockerInfo.ok,
      installed: dockerInstalled,
      running: dockerInfo.ok,
      detail: dockerInstalled ? dockerInfo.detail : 'Docker Desktop not found.',
    },
    compose: parseComposeVersion(compose.stdout, compose.code),
    node: parseNodeVersion(node.stdout),
    ollama: {
      ok: ollamaInstalled && ollamaRunning,
      installed: ollamaInstalled,
      running: ollamaRunning,
      path: ollamaPresence.path,
      detail: !ollamaInstalled
        ? 'Ollama not installed.'
        : ollamaTags === null
          ? `Ollama installed but not reachable at ${OLLAMA_URL}.`
          : `${models.length} model(s) pulled.`,
    },
    models: models.map((m) => m.name),
    recommendedModelPresent: hasModel(models, 'qwen3-embedding:4b'),
  }
}

function ndjson(reply: { hijack: () => void; raw: { writeHead: (c: number, h: object) => void; write: (s: string) => void; end: () => void } }): (e: unknown) => void {
  reply.hijack()
  reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
  return (e: unknown) => reply.raw.write(JSON.stringify(e) + '\n')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function prereqReady(component: PrereqComponent, state: Awaited<ReturnType<typeof prereqState>>): boolean {
  if (component === 'homebrew') return !!state.homebrew.ok
  if (component === 'node') return !!state.node.ok
  if (component === 'docker' || component === 'compose') return !!state.docker.ok && !!state.compose.ok
  if (component === 'ollama') return !!state.ollama.ok
  return false
}

async function waitForPrereqReady(component: PrereqComponent, emit: (e: unknown) => void): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    const state = await prereqState()
    if (prereqReady(component, state)) {
      emit({ type: 'stdout', id: `wait-${component}`, chunk: `${component} is ready.\n` })
      return true
    }
    const detail =
      component === 'homebrew' ? state.homebrew.detail :
        component === 'node' ? state.node.detail :
          component === 'ollama' ? state.ollama.detail :
            `${state.docker.detail} ${state.compose.detail}`
    emit({ type: 'stdout', id: `wait-${component}`, chunk: `${component}: ${detail} (${i + 1}/90)\n` })
    await sleep(2000)
  }
  return false
}

// ── Liveness ──────────────────────────────────────────────────────────────────
app.get('/healthz', async () => ({ ok: true }))

// ── Prerequisite probes ─────────────────────────────────────────────────────────
app.get('/api/prereqs', async () => {
  return prereqState()
})

async function runPrereqStep(step: PrereqInstallStep, emit: (e: unknown) => void): Promise<boolean> {
  const env = { ...(await brewEnv()), ...(step.env ?? {}) }
  const cmd = step.cmd[0] === 'brew' ? (await detectBrewPath()) ?? 'brew' : step.cmd[0]!
  emit({ type: 'step-start', id: step.id, name: step.name })
  return new Promise((resolve) => {
    const child = spawn(cmd, step.cmd.slice(1), {
      env,
      detached: !!step.detached,
      stdio: step.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    })
    if (step.detached) {
      child.unref()
      emit({ type: 'stdout', id: step.id, chunk: `${step.name} requested.\n` })
      emit({ type: 'step-done', id: step.id, ok: true })
      resolve(true)
      return
    }
    child.stdout?.on('data', (b: Buffer) => emit({ type: 'stdout', id: step.id, chunk: b.toString() }))
    child.stderr?.on('data', (b: Buffer) => emit({ type: 'stdout', id: step.id, chunk: b.toString() }))
    child.on('error', (err) => {
      emit({ type: 'stdout', id: step.id, chunk: `spawn error: ${err.message}\n` })
      emit({ type: 'step-done', id: step.id, ok: false })
      resolve(false)
    })
    child.on('close', (code) => {
      const ok = code === 0
      emit({ type: 'step-done', id: step.id, ok })
      resolve(ok)
    })
  })
}

app.post<{ Body: { component: PrereqComponent } }>('/api/prereqs/install', async (req, reply) => {
  const emit = ndjson(reply as never)
  try {
    const state = await prereqState()
    const plan = buildPrereqInstallPlan(req.body.component, {
      platform: process.platform,
      brewPath: state.homebrew.path,
      hasDocker: !!state.docker.installed,
      hasCompose: !!state.compose.ok,
      hasOllama: !!state.ollama.installed,
    })
    emit({ type: 'run-start', steps: plan.map((s) => ({ id: s.id, name: s.name })) })
    for (const step of plan) {
      const ok = await runPrereqStep(step, emit)
      if (!ok) {
        emit({ type: 'error', id: step.id, message: `Step "${step.name}" failed.` })
        emit({ type: 'done', ok: false })
        ;(reply as never as { raw: { end: () => void } }).raw.end()
        return
      }
    }
    const ready = await waitForPrereqReady(req.body.component, emit)
    if (!ready) {
      emit({ type: 'error', message: `${req.body.component} did not become ready in time.` })
      emit({ type: 'done', ok: false })
      ;(reply as never as { raw: { end: () => void } }).raw.end()
      return
    }
    emit({ type: 'done', ok: true })
  } catch (e) {
    emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    emit({ type: 'done', ok: false })
  }
  ;(reply as never as { raw: { end: () => void } }).raw.end()
})

// ── System specs (→ recommended model) + installed agent apps ────────────────────
app.get('/api/specs', async () => readSpecs())
app.get('/api/apps', async () => readApps())

// Native folder picker — host-only installer, so open the OS dialog and return the chosen
// absolute path (saves the user copying a path from Finder). darwin → osascript; linux → zenity.
app.post('/api/choose-folder', async () => {
  const plat = process.platform
  if (plat !== 'darwin' && plat !== 'linux') return { unsupported: true }
  const r = plat === 'darwin'
    ? await execCapture('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select a project folder")'])
    : await execCapture('zenity', ['--file-selection', '--directory', '--title=Select a project folder'])
  const out = r.stdout.trim()
  if (r.code === 0 && out) return { path: out.replace(/\/+$/, '') || '/' } // strip trailing slash; keep root "/"
  return { canceled: true } // non-zero = user canceled, or the picker binary is unavailable
})

// ── Default memory rule (editable in the wizard) ─────────────────────────────────
app.get('/api/rule/default', async () => ({
  ruleText: readDefaultRule(),
  memoryBlock: defaultMemoryBlock('@rules/persistent-memory.md'),
  rulePath: '.claude/rules/persistent-memory.md',
}))

// ── Test a REMOTE server (flows 2/3): public /config + token-gated /whoami ─────────
app.post<{ Body: { apiUrl: string; token: string } }>('/api/remote/test', async (req) => {
  const base = (req.body.apiUrl ?? '').replace(/\/+$/, '')
  if (!base) return { error: 'unreachable' as const, config: null, whoami: null }
  const config = await fetch(`${base}/config`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (!config) return { error: 'unreachable' as const, config: null, whoami: null }
  const whoami = await fetch(`${base}/whoami`, { headers: { authorization: `Bearer ${req.body.token}` } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (!whoami) return { error: 'bad_token' as const, config, whoami: null }
  return { config, whoami }
})

interface BitbucketTestBody {
  url?: string
  token?: string
  scope?: 'project' | 'user'
  project?: string
  user?: string
  repo?: string
  branch?: string
}

function bitbucketBranchUrl(body: BitbucketTestBody): string | null {
  const base = (body.url ?? '').trim().replace(/\/+$/, '')
  const repo = (body.repo ?? '').trim()
  const branch = (body.branch ?? '').trim()
  if (!base || !repo || !branch) return null
  try {
    const url = new URL(base)
    const owner = body.scope === 'user' ? (body.user ?? '').trim() : (body.project ?? '').trim()
    if (!owner) return null
    const ownerPath = body.scope === 'user'
      ? `/rest/api/1.0/users/${encodeURIComponent(owner)}`
      : `/rest/api/1.0/projects/${encodeURIComponent(owner)}`
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${ownerPath}/repos/${encodeURIComponent(repo)}/branches`
    url.searchParams.set('filterText', branch)
    return url.toString()
  } catch {
    return null
  }
}

app.post<{ Body: BitbucketTestBody }>('/api/update/test', async (req) => {
  const k = existingUserKeys()
  const token = (req.body.token ?? '').trim() || k.UPDATE_BITBUCKET_TOKEN || ''
  const target = bitbucketBranchUrl(req.body)
  if (!target || !token) return { ok: false, message: 'Fill every Bitbucket field before testing.' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const r = await fetch(target, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return {
        ok: false,
        message: `Bitbucket/Stash returned HTTP ${r.status}${text ? `: ${text.slice(0, 160)}` : ''}.`,
      }
    }
    return { ok: true, message: 'Bitbucket/Stash connection verified.' }
  } catch (e) {
    const message = e instanceof Error && e.name === 'AbortError'
      ? 'Bitbucket/Stash connection timed out.'
      : `Could not reach Bitbucket/Stash: ${e instanceof Error ? e.message : String(e)}.`
    return { ok: false, message }
  } finally {
    clearTimeout(timer)
  }
})

interface ExtractionTestBody {
  provider?: ExtractionProvider
  model?: string
  apiKey?: string
}

app.post<{ Body: ExtractionTestBody }>('/api/extraction/test', async (req) => {
  const provider = req.body.provider === 'openai' ? 'openai' : 'anthropic'
  const existing = existingUserKeys()
  const apiKey = (req.body.apiKey ?? '').trim() || (provider === 'anthropic' ? existing.ANTHROPIC_API_KEY : existing.OPENAI_API_KEY) || ''
  return testExtractionConnection({
    provider,
    model: req.body.model ?? '',
    apiKey,
  })
})

// ── Ollama: pull a model (NDJSON progress) ──────────────────────────────────────
app.post<{ Body: { model: string } }>('/api/ollama/pull', async (req, reply) => {
  const emit = ndjson(reply as never)
  await new Promise<void>((resolve) => {
    const child = spawn('ollama', ['pull', req.body.model])
    child.stdout.on('data', (b: Buffer) => emit({ type: 'stdout', chunk: b.toString() }))
    child.stderr.on('data', (b: Buffer) => emit({ type: 'stdout', chunk: b.toString() }))
    child.on('error', (err) => emit({ type: 'error', message: err.message }))
    child.on('close', (code) => {
      emit({ type: 'done', ok: code === 0 })
      resolve()
    })
  })
  ;(reply as never as { raw: { end: () => void } }).raw.end()
})

// User-provided API keys already in the .env (so the wizard can pre-detect them). The
// auto-generated secrets (TOKEN_PEPPER/DOCKER_CONTROL_TOKEN/USAGE_INGEST_TOKEN/DB/MinIO) are NOT
// read back — genSecrets always regenerates them fresh on each /api/env (checked → replaced).
function existingUserKeys(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {}
  const env = parseEnvFile(readFileSync(ENV_PATH, 'utf8'))
  const out: Record<string, string> = {}
  for (const k of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
    'UPDATE_BITBUCKET_TOKEN',
    'UPDATE_CHECK_PROVIDER',
    'UPDATE_BITBUCKET_URL',
    'UPDATE_BITBUCKET_SCOPE',
    'UPDATE_BITBUCKET_PROJECT',
    'UPDATE_BITBUCKET_USER',
    'UPDATE_BITBUCKET_REPO',
    'UPDATE_BITBUCKET_BRANCH',
  ]) {
    if (env[k] && env[k].trim()) out[k] = env[k]
  }
  return out
}

app.get('/api/env/existing', async () => {
  const k = existingUserKeys()
  return {
    anthropicKeyPresent: Boolean(k.ANTHROPIC_API_KEY),
    openaiKeyPresent: Boolean(k.OPENAI_API_KEY),
    voyageKeyPresent: Boolean(k.VOYAGE_API_KEY),
    updateProvider: k.UPDATE_CHECK_PROVIDER ?? 'none',
    updateBitbucketUrl: k.UPDATE_BITBUCKET_URL ?? '',
    updateBitbucketTokenPresent: Boolean(k.UPDATE_BITBUCKET_TOKEN),
    updateBitbucketScope: k.UPDATE_BITBUCKET_SCOPE ?? 'project',
    updateBitbucketProject: k.UPDATE_BITBUCKET_PROJECT ?? '',
    updateBitbucketUser: k.UPDATE_BITBUCKET_USER ?? '',
    updateBitbucketRepo: k.UPDATE_BITBUCKET_REPO ?? '',
    updateBitbucketBranch: k.UPDATE_BITBUCKET_BRANCH ?? 'master',
  }
})

// ── Generate + write the .env ───────────────────────────────────────────────────
app.post<{ Body: { answers: Answers } }>('/api/env', async (req) => {
  const oldEnv = existsSync(ENV_PATH) ? parseEnvFile(readFileSync(ENV_PATH, 'utf8')) : {}
  const a: Answers = { ...req.body.answers }
  // Preserve USER-provided API keys when the wizard left them blank — don't make the user re-paste.
  if (!a.anthropicApiKey?.trim() && oldEnv.ANTHROPIC_API_KEY) a.anthropicApiKey = oldEnv.ANTHROPIC_API_KEY
  if (!a.openaiApiKey?.trim() && oldEnv.OPENAI_API_KEY) a.openaiApiKey = oldEnv.OPENAI_API_KEY
  if (!a.voyageApiKey?.trim() && oldEnv.VOYAGE_API_KEY) a.voyageApiKey = oldEnv.VOYAGE_API_KEY
  if (!a.updateBitbucketToken?.trim() && oldEnv.UPDATE_BITBUCKET_TOKEN) {
    a.updateBitbucketToken = oldEnv.UPDATE_BITBUCKET_TOKEN
  }
  if ((a.deploymentMode ?? 'server') === 'local') {
    a.userPasswordConfiguredAt = new Date().toISOString()
  }
  const secrets = genSecrets()
  // PRESERVE the volume-tied passwords (POSTGRES/PM_APP/MINIO) from the existing .env — regenerating
  // them breaks auth against the persistent Postgres/MinIO volumes (the password is set only on FIRST
  // volume init, so a new value never matches an existing volume → P1000 on migrate). The app secrets
  // (TOKEN_PEPPER/DOCKER_CONTROL_TOKEN/USAGE_INGEST_TOKEN) are NOT volume-tied → stay freshly generated.
  if (oldEnv.POSTGRES_PASSWORD) secrets.postgresPassword = oldEnv.POSTGRES_PASSWORD
  if (oldEnv.PM_APP_PASSWORD) secrets.pmAppPassword = oldEnv.PM_APP_PASSWORD
  if (oldEnv.MINIO_ROOT_PASSWORD) secrets.minioRootPassword = oldEnv.MINIO_ROOT_PASSWORD
  const env = renderEnv(a, secrets)
  writeFileSync(ENV_PATH, env, { mode: 0o600 })
  return { path: ENV_PATH, preview: maskEnv(env), issues: validateEnvForDeploy(parseEnvFile(env)) }
})

// ── Run the install (NDJSON stream) — flow-aware ─────────────────────────────────
interface InstallBody {
  flow?: 'full' | 'engine' | 'mcp'
  mcpRuntime?: 'stream' | 'node'
  personalMemoryEnabled?: boolean
  memoryInstallMode?: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface?: 'personal' | 'shared'
  personalApiUrl?: string
  personalUserToken?: string
  sharedApiUrl?: string
  sharedUserToken?: string
  teamName?: string
  userEmail?: string
  userName?: string
  userPassword?: string
  remoteApiUrl?: string
  remoteOllamaUrl?: string
  remoteToken?: string
  pullModel?: string
  apps?: { claudeCli?: boolean; claudeDesktop?: boolean; codexCli?: boolean; codexDesktop?: boolean }
  regLevel?: 'global' | 'project'
  projectPaths?: string[]
  ruleBody?: string
  memoryBlock?: string
}

/** Build the WizardPayload from the request body + server-side defaults. The
 * remote token is used only transiently here (passed to the register step → the
 * MCP config files); it is NEVER written to .env.persistent-memory. */
function buildWizardPayload(body: InstallBody): WizardPayload {
  const flow = body.flow ?? 'full'
  const mcpRuntime = 'stream'
  const localApi = 'http://localhost:8090'
  const localOllama = 'http://localhost:11434'
  const streamUrl = 'http://127.0.0.1:8091/mcp'
  const personalApiUrl = body.personalApiUrl ?? localApi
  const sharedApiUrl = body.sharedApiUrl ?? body.remoteApiUrl
  const sharedUserToken = body.sharedUserToken ?? body.remoteToken
  const wantsShared = Boolean(sharedApiUrl && sharedUserToken)
  const memoryInstallMode = body.memoryInstallMode ?? (wantsShared ? 'personal-and-shared' : 'personal-only')
  const personalMemoryEnabled = true
  const defaultMemorySurface = body.defaultMemorySurface ?? 'personal'
  return {
    flow,
    mcpRuntime,
    personalMemoryEnabled,
    memoryInstallMode,
    defaultMemorySurface,
    personalApiUrl,
    personalUserToken: body.personalUserToken,
    sharedApiUrl: memoryInstallMode === 'personal-and-shared' ? sharedApiUrl : undefined,
    sharedUserToken: memoryInstallMode === 'personal-and-shared' ? sharedUserToken : undefined,
    apiUrl: personalApiUrl,
    ollamaUrl: localOllama,
    streamUrl,
    token: '',
    pullModel: body.pullModel,
    wrapperPath: join(PM_ROOT, 'apps', 'mcp', 'persistent-memory-mcp.sh'),
    home: homedir(),
    apps: {
      claudeCli: body.apps?.claudeCli ?? false,
      claudeDesktop: body.apps?.claudeDesktop ?? false,
      codexCli: body.apps?.codexCli ?? false,
      codexDesktop: body.apps?.codexDesktop ?? false,
    },
    regLevel: body.regLevel ?? 'global',
    projectPaths: body.projectPaths ?? [],
    ruleBody: body.ruleBody && body.ruleBody.trim() ? body.ruleBody : readDefaultRule(),
    memoryBlock: body.memoryBlock && body.memoryBlock.trim() ? body.memoryBlock : defaultMemoryBlock('@rules/persistent-memory.md'),
  }
}

app.post<{ Body: InstallBody }>('/api/install', async (req, reply) => {
  const body = req.body ?? {}
  const needsLocalEnv = true
  let env: Record<string, string> = {}
  if (needsLocalEnv) {
    // Full local-server installs and client installs with isolated personal memory
    // need a generated local .env. Shared-only client flows never touch the stack.
    if (!existsSync(ENV_PATH)) {
      return reply.code(400).send({ error: 'no_env', message: 'Generate the .env first (POST /api/env).' })
    }
    env = parseEnvFile(readFileSync(ENV_PATH, 'utf8'))
    const issues = validateEnvForDeploy(env)
    if (issues.length > 0) {
      return reply.code(400).send({
        error: 'invalid_env',
        message: `Missing required env value(s): ${issues.map((i) => i.key).join(', ')}`,
        issues,
      })
    }
  }
  const wizard = buildWizardPayload(body)
  const emit = ndjson(reply as never)
  const wrapped = (e: InstallEvent): void => {
    if (e.type === 'token' && e.token) bootstrapToken = e.token
    emit(e)
  }
  await runInstall({ root: PM_ROOT, env, wizard }, wrapped)
  ;(reply as never as { raw: { end: () => void } }).raw.end()
})

// ── The dashboard URL (so the Done screen knows where to redirect) ───────────────
app.get('/api/finish', async () => ({ dashboardUrl, hasToken: bootstrapToken !== null }))

// ── Self-terminate (after the redirect to the dashboard) ─────────────────────────
app.post('/api/shutdown', async (_req, reply) => {
  reply.send({ ok: true })
  setTimeout(() => process.exit(0), 250)
})

// ── Static SPA (built by vite into web/dist) + SPA fallback ──────────────────────
const DIST = join(import.meta.dirname, '..', 'web', 'dist')
if (existsSync(DIST)) {
  await app.register(fastifyStatic, { root: DIST })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url === '/healthz') return reply.code(404).send({ error: 'not_found' })
    return reply.sendFile('index.html')
  })
}

// Idle self-exit so an abandoned tab doesn't leak the process (30 min).
let lastActivity = Date.now()
app.addHook('onRequest', async () => {
  lastActivity = Date.now()
})
setInterval(() => {
  if (Date.now() - lastActivity > 30 * 60 * 1000) process.exit(0)
}, 60_000).unref()

await app.listen({ host: '127.0.0.1', port: PORT })
// eslint-disable-next-line no-console
console.log(`onboard: http://127.0.0.1:${PORT}`)
