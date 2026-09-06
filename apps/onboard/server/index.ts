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
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { validateEnvForDeploy } from './env.js'
import { registerEnvWriteRoute } from './env-route.js'
import {
  buildPrereqInstallPlan,
  prereqInstallCapabilities,
  parseCommandPresence,
  parseDockerInfo,
  parseComposeVersion,
  parseNodeVersion,
  parseOllamaTags,
  hasModel,
  homebrewManualInstallCommands,
  manualPrereqHint,
  type PrereqComponent,
  type PrereqInstallStep,
} from './prereq.js'
import { runInstall, parseEnvFile, type InstallEvent, type WizardPayload } from './install.js'
import { readSpecs, readApps } from './detect.js'
import { readDefaultRule, defaultMemoryBlock } from './rule.js'
import { originGuardReason } from './guard.js'
import { testExtractionConnection, type ExtractionProvider } from './extraction-test.js'
import { hostCommand, hostEnvironment, nativeWindowsPath, presenceCommand } from './host.js'
import { IdleLifecycle } from './idle-lifecycle.js'
import { createNdjsonStream } from './ndjson.js'
import { createPrereqOutputParser } from './progress.js'
import { chooseFolder } from './folder-picker.js'
import { agentProfileEnvironment } from './agent-profiles.js'

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.ONBOARD_PORT ?? 4319)
const PM_ROOT = process.platform === 'win32' ? nativeWindowsPath(process.env.PM_ROOT ?? process.cwd()) : process.env.PM_ROOT ?? process.cwd()
const API_URL = process.env.API_URL ?? 'http://localhost:8090'
const DEFAULT_DASHBOARD_URL = 'http://localhost:3200'
const ENV_PATH = join(PM_ROOT, '.env.persistent-memory')
// This server runs on the host; generated Compose environments address the same
// host service through Docker's hostname instead.
const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://localhost:11434')
  .replace('host.docker.internal', 'localhost').replace(/\/$/, '')

// In-memory only — the captured bootstrap token (shown once; never persisted).
let bootstrapToken: string | null = null
const dashboardUrl = process.env.DASHBOARD_URL ?? process.env.ADMIN_URL ?? DEFAULT_DASHBOARD_URL

const app = Fastify({ logger: false })
const idleLifecycle = new IdleLifecycle()
app.addHook('onRequest', async () => { idleLifecycle.touch() })

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
    let resolved: ReturnType<typeof hostCommand>
    try { resolved = hostCommand(cmd, args) } catch (error) { resolve({ code: 1, stdout: String(error) }); return }
    const child = spawn(resolved.command, resolved.args, { env: resolved.env, windowsHide: true })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    child.stderr.on('data', (b: Buffer) => (stdout += b.toString()))
    child.on('error', () => resolve({ code: 1, stdout }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
}

async function detectBrewPath(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const which = await execCapture('which', ['brew'])
  if (which.code === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0] ?? null
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(p)) return p
  }
  return null
}

async function brewEnv(): Promise<NodeJS.ProcessEnv> {
  const brew = await detectBrewPath()
  const env = hostEnvironment()
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
    execCapture('docker', ['info', '--format', '{{.OSType}}']),
    execCapture('docker', ['compose', 'version']),
    execCapture('node', ['-v']),
    execCapture(presenceCommand('ollama').command, presenceCommand('ollama').args),
    fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
  ])
  const models = parseOllamaTags(ollamaTags)
  const dockerInstalled = dockerVersion.code === 0
  const dockerInfo = parseDockerInfo(docker.stdout, docker.code)
  const ollamaPresence = parseCommandPresence('Ollama', ollamaWhich.stdout, ollamaWhich.code)
  const ollamaInstalled = !!ollamaPresence.installed
  const ollamaRunning = !!ollamaTags && typeof ollamaTags === 'object'
    && 'models' in ollamaTags && Array.isArray(ollamaTags.models)
  return {
    platform: process.platform,
    automaticInstallSupported: process.platform === 'darwin' || process.platform === 'win32',
    automaticInstallComponents: prereqInstallCapabilities(process.platform),
    manualHints: process.platform === 'darwin' ? null : Object.fromEntries(
      (['node', 'docker', 'compose', 'ollama'] as const).map((key) => [key,
        key === 'ollama' && process.platform === 'win32'
          ? 'Choose Install to download the official Ollama installer, or Start to run an existing installation. The wizard checks readiness automatically.'
          : manualPrereqHint(key, process.platform)]),
    ),
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
        : !ollamaRunning
          ? `Ollama installed but not reachable at ${OLLAMA_URL}.`
          : `${models.length} model(s) pulled.`,
    },
    models: models.map((m) => m.name),
    recommendedModelPresent: hasModel(models, 'qwen3-embedding:4b'),
  }
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
  emit({ type: 'progress', id: `wait-${component}`, stage: 'ready' })
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
  const env = { ...(await brewEnv()), ...(step.env ?? {}), PM_OLLAMA_URL: OLLAMA_URL }
  const cmd = step.cmd[0] === 'brew' ? (await detectBrewPath()) ?? 'brew' : step.cmd[0]!
  emit({ type: 'step-start', id: step.id, name: step.name })
  return new Promise((resolve) => {
    const resolved = hostCommand(cmd, step.cmd.slice(1), { env })
    const child = spawn(resolved.command, resolved.args, {
      env: resolved.env,
      windowsHide: true,
      detached: !!step.detached,
      stdio: step.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    })
    if (step.detached) child.once('spawn', () => {
      child.unref()
      emit({ type: 'stdout', id: step.id, chunk: `${step.name} requested.\n` })
      emit({ type: 'step-done', id: step.id, ok: true })
      resolve(true)
    })
    const stdout = createPrereqOutputParser(step.id, emit)
    const stderr = createPrereqOutputParser(step.id, emit)
    child.stdout?.on('data', (b: Buffer) => stdout.write(b))
    child.stderr?.on('data', (b: Buffer) => stderr.write(b))
    child.on('error', (err) => {
      emit({ type: 'stdout', id: step.id, chunk: `spawn error: ${err.message}\n` })
      emit({ type: 'step-done', id: step.id, ok: false })
      resolve(false)
    })
    child.on('close', (code) => {
      stdout.end()
      stderr.end()
      if (step.detached) return
      const ok = code === 0
      emit({ type: 'step-done', id: step.id, ok })
      resolve(ok)
    })
  })
}

let prerequisiteInstallActive = false
app.post<{ Body: { component: PrereqComponent } }>('/api/prereqs/install', async (req, reply) => {
  if (prerequisiteInstallActive) return reply.code(409).send({ error: 'A prerequisite installation is already running. Wait for it to finish.' })
  const stream = createNdjsonStream(reply)
  const { emit } = stream
  prerequisiteInstallActive = true
  const releaseWork = idleLifecycle.beginWork()
  try {
    const state = await prereqState()
    const plan = buildPrereqInstallPlan(req.body.component, {
      platform: process.platform,
      brewPath: state.homebrew.path,
      hasDocker: !!state.docker.installed,
      hasCompose: !!state.compose.ok,
      hasOllama: !!state.ollama.installed,
      root: PM_ROOT,
    })
    emit({ type: 'run-start', steps: plan.map((s) => ({ id: s.id, name: s.name })) })
    for (const step of plan) {
      const ok = await runPrereqStep(step, emit)
      if (!ok) {
        emit({ type: 'error', id: step.id, message: `Step "${step.name}" failed.` })
        emit({ type: 'done', ok: false })
        return
      }
    }
    const ready = await waitForPrereqReady(req.body.component, emit)
    if (!ready) {
      emit({ type: 'error', message: `${req.body.component} did not become ready in time.` })
      emit({ type: 'done', ok: false })
      return
    }
    emit({ type: 'done', ok: true })
  } catch (e) {
    emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    emit({ type: 'done', ok: false })
  } finally {
    prerequisiteInstallActive = false
    releaseWork()
    stream.end()
  }
})

// ── System specs (→ recommended model) + installed agent apps ────────────────────
app.get('/api/specs', async () => readSpecs())
app.get('/api/apps', async () => readApps())

// The host dialog appears only when the user chooses a project folder.
app.post('/api/choose-folder', async () => chooseFolder(process.platform, execCapture))

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
  const stream = createNdjsonStream(reply)
  const { emit } = stream
  const releaseWork = idleLifecycle.beginWork()
  try {
    await new Promise<void>((resolve) => {
      const resolved = hostCommand('ollama', ['pull', req.body.model])
      const child = spawn(resolved.command, resolved.args, { env: resolved.env, windowsHide: true })
      child.stdout.on('data', (b: Buffer) => emit({ type: 'stdout', chunk: b.toString() }))
      child.stderr.on('data', (b: Buffer) => emit({ type: 'stdout', chunk: b.toString() }))
      child.on('error', (err) => emit({ type: 'error', message: err.message }))
      child.on('close', (code) => {
        emit({ type: 'done', ok: code === 0 })
        resolve()
      })
    })
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    emit({ type: 'done', ok: false })
  } finally {
    releaseWork()
    stream.end()
  }
})

// Only provider-key presence is exposed to the browser. Generated service secrets
// stay server-side and are preserved when the wizard saves an existing env file.
function existingUserKeys(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {}
  const env = parseEnvFile(readFileSync(ENV_PATH, 'utf8'))
  const out: Record<string, string> = {}
  for (const k of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
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
  }
})

// ── Generate + write the .env ───────────────────────────────────────────────────
registerEnvWriteRoute(app, ENV_PATH)

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
    profileEnv: agentProfileEnvironment(process.env),
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
  const stream = createNdjsonStream(reply)
  const { emit } = stream
  const releaseWork = idleLifecycle.beginWork()
  const wrapped = (e: InstallEvent): void => {
    if (e.type === 'token' && e.token) bootstrapToken = e.token
    emit(e)
  }
  try {
    await runInstall({ root: PM_ROOT, env, wizard }, wrapped)
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    emit({ type: 'done', ok: false })
  } finally {
    releaseWork()
    stream.end()
  }
})

// ── The dashboard URL (so the Done screen knows where to redirect) ───────────────
app.get('/api/finish', async () => ({ dashboardUrl, hasToken: bootstrapToken !== null }))

// ── Self-terminate (after the redirect to the dashboard) ─────────────────────────
app.post('/api/shutdown', async (_req, reply) => {
  reply.send({ ok: true })
  setTimeout(() => process.exit(0), 250)
})

// ── Static SPA (built by vite into web/dist) + SPA fallback ──────────────────────
const DIST = join(PM_ROOT, 'apps', 'onboard', 'web', 'dist')
if (existsSync(DIST)) {
  await app.register(fastifyStatic, { root: DIST })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url === '/healthz') return reply.code(404).send({ error: 'not_found' })
    return reply.sendFile('index.html')
  })
}

// Idle self-exit applies only after all host operations have finished. Streaming
// work can run for hours without another request, including after a tab closes.
setInterval(() => {
  if (idleLifecycle.shouldExit()) process.exit(0)
}, 60_000).unref()

await app.listen({ host: '127.0.0.1', port: PORT })
// eslint-disable-next-line no-console
console.log(`onboard: http://127.0.0.1:${PORT}`)
