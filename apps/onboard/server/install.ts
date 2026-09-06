/**
 * persistent-memory-onboard — install orchestrator.
 *
 * Spawns the ordered install steps (buildSteps) as child processes WITHOUT a
 * shell (argv arrays — no interpolation), streams stdout/stderr as NDJSON events,
 * captures the show-once bootstrap token from the seed step, and polls the
 * 'wait' steps until Postgres and stream MCP are healthy. Stops on the first failure.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { buildSteps, extractToken, parseVerifySummary, type InstallStep } from './steps.js'
import { hasModel, parseOllamaTags } from './prereq.js'
import {
  buildMcpEntry,
  registerClaudeWrite,
  registerCodexWrite,
  planRegistration,
} from './register.js'
import { targetMemoryFiles, writeRuleTargets } from './rule.js'
import { writeOwnershipManifest } from './ownership.js'
import { hostCommand } from './host.js'

export type InstallEvent =
  | { type: 'run-start'; total: number; steps: { id: string; name: string }[] }
  | { type: 'step-start'; id: string; name: string; index: number; total: number }
  | { type: 'stdout'; id: string; chunk: string }
  | { type: 'step-done'; id: string; ok: boolean }
  | { type: 'token'; token?: string; already?: boolean }
  | { type: 'verify'; pass: number; fail: number; warn: number }
  | { type: 'done'; ok: boolean }
  | { type: 'error'; id: string; message: string }

export interface WizardApps {
  claudeCli: boolean
  claudeDesktop: boolean
  codexCli: boolean
  codexDesktop: boolean
}

/** Everything the 'fn' steps (register / write-rule) need. Built from the wizard. */
export interface WizardPayload {
  flow: 'full' | 'engine' | 'mcp'
  /** @deprecated Node is accepted from older wizard state, but stream is the only runtime. */
  mcpRuntime: 'stream' | 'node'
  personalMemoryEnabled?: boolean
  memoryInstallMode?: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface?: 'personal' | 'shared'
  personalApiUrl?: string
  personalUserToken?: string
  sharedApiUrl?: string
  sharedUserToken?: string
  apiUrl: string
  ollamaUrl: string
  streamUrl: string
  /** Remote token (client flows). Empty for full — captured from the seed step. */
  token: string
  pullModel?: string
  /** Absolute path to apps/mcp/persistent-memory-mcp.sh (node launch). */
  wrapperPath: string
  home: string
  /** Host profile directories, supplied by the server rather than browser input. */
  profileEnv?: NodeJS.ProcessEnv
  apps: WizardApps
  regLevel: 'global' | 'project'
  projectPaths: string[]
  ruleBody: string
  memoryBlock: string
}

export interface InstallContext {
  /** repo root (PM_ROOT). */
  root: string
  /** the parsed .env.persistent-memory (full flow; loaded into each child's env). */
  env: Record<string, string>
  /** the wizard answers needed by the 'fn' steps + flow selection. */
  wizard?: WizardPayload
}

/** Register the MCP into the selected agent apps' configs (in-process 'fn' step). */
function doRegister(ctx: InstallContext, token: string, emit: (e: InstallEvent) => void): boolean {
  const w = ctx.wizard
  if (!w) {
    emit({ type: 'stdout', id: 'register', chunk: 'no wizard payload — skipping registration\n' })
    return false
  }
  try {
    // Map the selected apps + scope → the exact config writes (directory-aware; see planRegistration).
    const plan = planRegistration({ apps: w.apps, level: w.regLevel, projectPaths: w.projectPaths, home: w.home, profileEnv: w.profileEnv, mcpRuntime: w.mcpRuntime })
    for (const item of plan.writes) {
      const entry = buildMcpEntry({
        mcpRuntime: w.mcpRuntime,
        apiUrl: w.apiUrl,
        ollamaUrl: w.ollamaUrl,
        token,
        wrapperPath: w.wrapperPath,
        streamUrl: w.streamUrl,
        clientName: item.clientName,
        memoryInstallMode: w.memoryInstallMode,
        defaultMemorySurface: w.defaultMemorySurface,
        personalApiUrl: w.personalApiUrl,
        personalUserToken: w.personalUserToken,
        sharedApiUrl: w.sharedApiUrl,
        sharedUserToken: w.sharedUserToken,
      })
      if (item.kind === 'claude') {
        registerClaudeWrite({ path: item.path, entry, level: item.level, projectPaths: item.projectPaths ?? [] })
      } else {
        registerCodexWrite(item.path, entry)
      }
      emit({ type: 'stdout', id: 'register', chunk: `✓ ${item.label}\n` })
    }
    return true
  } catch (e) {
    emit({ type: 'stdout', id: 'register', chunk: `register failed: ${e instanceof Error ? e.message : String(e)}\n` })
    return false
  }
}

/** Write the detailed rule body + idempotent top memory block into target memory files. */
function doWriteRule(ctx: InstallContext, emit: (e: InstallEvent) => void): boolean {
  const w = ctx.wizard
  if (!w) return false
  try {
    // Claude reads the project CLAUDE.md in folder sessions whether via Code or Desktop, so the rule
    // targets Claude when EITHER is selected (mirrors the directory-aware MCP scope).
    const targets = targetMemoryFiles({ claude: w.apps.claudeCli || w.apps.claudeDesktop, codex: w.apps.codexCli || w.apps.codexDesktop, level: w.regLevel, projectPaths: w.projectPaths, home: w.home, profileEnv: w.profileEnv })
    writeRuleTargets(targets, w.ruleBody, w.memoryBlock)
    if (targets.length === 0) emit({ type: 'stdout', id: 'write-rule', chunk: 'No CLAUDE.md/AGENTS.md targets — rule not written.\n' })
    for (const t of targets) emit({ type: 'stdout', id: 'write-rule', chunk: `✓ ${t.ruleFile} (+ ref in ${t.memoryFile})\n` })
    return true
  } catch (e) {
    emit({ type: 'stdout', id: 'write-rule', chunk: `write-rule failed: ${e instanceof Error ? e.message : String(e)}\n` })
    return false
  }
}

async function doSharedConnect(ctx: InstallContext, emit: (e: InstallEvent) => void): Promise<boolean> {
  const w = ctx.wizard
  if (!w || w.memoryInstallMode !== 'personal-and-shared') {
    emit({ type: 'stdout', id: 'shared-connect', chunk: 'Shared Memories not selected — skipping.\n' })
    return true
  }
  if (!w.sharedApiUrl || !w.sharedUserToken) {
    emit({ type: 'stdout', id: 'shared-connect', chunk: 'Shared API URL and connector token are required.\n' })
    return false
  }
  try {
    const res = await fetch(`${w.personalApiUrl ?? 'http://localhost:8090'}/dashboard/shared-connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiUrl: w.sharedApiUrl, token: w.sharedUserToken }),
    })
    if (!res.ok) {
      let message = `${res.status}`
      try {
        const body = (await res.json()) as { message?: string; error?: string }
        message = body.message ?? body.error ?? message
      } catch {
        /* ignore non-json error body */
      }
      emit({ type: 'stdout', id: 'shared-connect', chunk: `Shared connection failed: ${message}\n` })
      return false
    }
    emit({ type: 'stdout', id: 'shared-connect', chunk: 'Shared Memories connection saved in the local dashboard.\n' })
    return true
  } catch (e) {
    emit({ type: 'stdout', id: 'shared-connect', chunk: `Shared connection failed: ${e instanceof Error ? e.message : String(e)}\n` })
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function waitLabel(step: InstallStep): string {
  if (step.id === 'wait-postgres') return 'postgres'
  if (step.id === 'wait-mcp') return 'stream mcp'
  return step.name.toLowerCase()
}

function waitFailureMessage(step: InstallStep): string {
  if (step.id === 'wait-postgres') return 'Postgres did not become healthy in time.'
  if (step.id === 'wait-mcp') return 'Stream MCP did not become healthy in time.'
  return `${step.name} did not become healthy in time.`
}

/** Run one step to exit, streaming output. Resolves the full stdout (for capture). */
function runStep(
  step: InstallStep,
  ctx: InstallContext,
  emit: (e: InstallEvent) => void,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let resolved: ReturnType<typeof hostCommand>
    try {
      resolved = hostCommand(step.cmd[0]!, step.cmd.slice(1), { env: { ...process.env, ...ctx.env, ...(step.envOverride ?? {}) } })
    } catch (error) {
      const stdout = `${error instanceof Error ? error.message : String(error)}\n`
      emit({ type: 'stdout', id: step.id, chunk: stdout })
      resolve({ code: 1, stdout })
      return
    }
    const child = spawn(resolved.command, resolved.args, {
      cwd: join(ctx.root, step.cwd),
      env: resolved.env,
      windowsHide: true,
    })
    let stdout = ''
    const onData = (b: Buffer): void => {
      const chunk = b.toString()
      stdout += chunk
      emit({ type: 'stdout', id: step.id, chunk })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => {
      emit({ type: 'stdout', id: step.id, chunk: `spawn error: ${err.message}\n` })
      resolve({ code: 1, stdout })
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
}

/** Poll `docker inspect …Health.Status` until 'healthy' (or give up). */
async function waitHealthy(
  step: InstallStep,
  ctx: InstallContext,
  emit: (e: InstallEvent) => void,
): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const { stdout } = await runStepSilent(step, ctx)
    const status = stdout.trim()
    emit({ type: 'stdout', id: step.id, chunk: `${waitLabel(step)}: ${status || 'starting'} (${i + 1}/60)\n` })
    if (status === 'healthy') return true
    await sleep(2000)
  }
  return false
}

/** Like runStep but without streaming (used by the wait poll). */
function runStepSilent(step: InstallStep, ctx: InstallContext): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let resolved: ReturnType<typeof hostCommand>
    try {
      resolved = hostCommand(step.cmd[0]!, step.cmd.slice(1), { env: { ...process.env, ...ctx.env, ...(step.envOverride ?? {}) } })
    } catch (error) { resolve({ code: 1, stdout: String(error) }); return }
    const child = spawn(resolved.command, resolved.args, {
      cwd: join(ctx.root, step.cwd),
      env: resolved.env,
      windowsHide: true,
    })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    child.stderr.on('data', (b: Buffer) => (stdout += b.toString()))
    child.on('error', () => resolve({ code: 1, stdout }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
}

function hostOllamaUrl(ctx: InstallContext): string {
  const raw = ctx.env.OLLAMA_URL || ctx.wizard?.ollamaUrl || 'http://localhost:11434'
  return raw.replace('host.docker.internal', 'localhost')
}

async function modelIsPulled(ctx: InstallContext, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${hostOllamaUrl(ctx).replace(/\/$/, '')}/api/tags`)
    const json = await res.json()
    return hasModel(parseOllamaTags(json), model)
  } catch {
    return false
  }
}

export async function runInstall(ctx: InstallContext, emit: (e: InstallEvent) => void): Promise<void> {
  const w = ctx.wizard
  const flow = w?.flow ?? 'full'
  const steps = buildSteps({
    flow,
    env: ctx.env,
    mcpRuntime: w?.mcpRuntime,
    pullModel: w?.pullModel,
    personalMemoryEnabled: w?.personalMemoryEnabled,
    streamApiUrl: w?.apiUrl,
    streamToken: w?.token,
    streamOllamaUrl: w?.ollamaUrl,
    memoryInstallMode: w?.memoryInstallMode,
  })
  emit({ type: 'run-start', total: steps.length, steps: steps.map((s) => ({ id: s.id, name: s.name })) })

  // The server can also be started directly, bypassing the lifecycle launcher.
  // Resolve required host runtimes before any dependency install or Compose start.
  for (const step of steps) {
    if (step.kind === 'fn' || !step.cmd.length) continue
    try {
      hostCommand(step.cmd[0]!, step.cmd.slice(1), { env: { ...process.env, ...ctx.env, ...(step.envOverride ?? {}) } })
    } catch (error) {
      emit({ type: 'error', id: step.id, message: error instanceof Error ? error.message : String(error) })
      emit({ type: 'done', ok: false })
      return
    }
  }

  // Effective token for the register step: the remote token (client flows) or the
  // one captured live from the seed step (full flow).
  let token = w?.token ?? ''

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    emit({ type: 'step-start', id: step.id, name: step.name, index: i, total: steps.length })

    if (step.kind === 'wait') {
      const ok = await waitHealthy(step, ctx, emit)
      emit({ type: 'step-done', id: step.id, ok })
      if (!ok) {
        emit({ type: 'error', id: step.id, message: waitFailureMessage(step) })
        emit({ type: 'done', ok: false })
        return
      }
      continue
    }

    if (step.kind === 'ollama-model') {
      const model = step.cmd[2] ?? ''
      if (!model) {
        emit({ type: 'stdout', id: step.id, chunk: 'no Ollama model configured — skipping\n' })
        emit({ type: 'step-done', id: step.id, ok: true })
        continue
      }
      if (await modelIsPulled(ctx, model)) {
        emit({ type: 'stdout', id: step.id, chunk: `Ollama model ${model} already installed — skipping pull\n` })
        emit({ type: 'step-done', id: step.id, ok: true })
        continue
      }
      const { code } = await runStep(step, ctx, emit)
      const ok = code === 0
      emit({ type: 'step-done', id: step.id, ok })
      if (!ok) {
        emit({ type: 'error', id: step.id, message: `Step "${step.name}" failed — see output above.` })
        emit({ type: 'done', ok: false })
        return
      }
      continue
    }

    if (step.kind === 'fn') {
      const ok = step.fnId === 'register'
        ? doRegister(ctx, token, emit)
        : step.fnId === 'shared-connect'
          ? await doSharedConnect(ctx, emit)
          : doWriteRule(ctx, emit)
      emit({ type: 'step-done', id: step.id, ok })
      if (!ok) {
        emit({ type: 'error', id: step.id, message: `Step "${step.name}" failed — see output above.` })
        emit({ type: 'done', ok: false })
        return
      }
      continue
    }

    if (step.kind === 'cleanup') {
      const { code, stdout } = await runStepSilent(step, ctx)
      if (code === 0 && stdout.trim()) {
        emit({ type: 'stdout', id: step.id, chunk: stdout.endsWith('\n') ? stdout : `${stdout}\n` })
      } else if (code !== 0) {
        emit({ type: 'stdout', id: step.id, chunk: 'No existing local stream MCP container to replace.\n' })
      }
      emit({ type: 'step-done', id: step.id, ok: true })
      continue
    }

    const { code, stdout } = await runStep(step, ctx, emit)
    if (step.captureToken) {
      const tok = extractToken(stdout)
      if (tok && 'token' in tok) {
        token = tok.token // feed the register step (full flow)
        emit({ type: 'token', token: tok.token })
      } else if (tok && 'already' in tok) emit({ type: 'token', already: true })
    }
    if (step.id === 'verify') emit({ type: 'verify', ...parseVerifySummary(stdout) })

    const ok = code === 0
    emit({ type: 'step-done', id: step.id, ok })
    if (!ok) {
      emit({ type: 'error', id: step.id, message: `Step "${step.name}" exited with code ${code}.` })
      emit({ type: 'done', ok: false })
      return
    }
  }
  if (w) {
    const registrations = planRegistration({ apps: w.apps, level: w.regLevel, projectPaths: w.projectPaths, home: w.home, profileEnv: w.profileEnv, mcpRuntime: w.mcpRuntime }).writes
    const rules = targetMemoryFiles({ claude: w.apps.claudeCli || w.apps.claudeDesktop, codex: w.apps.codexCli || w.apps.codexDesktop, level: w.regLevel, projectPaths: w.projectPaths, home: w.home, profileEnv: w.profileEnv })
    writeOwnershipManifest(w.home, [
      ...registrations.map((item) => ({ path: item.path, artifactType: 'mcp-registration' as const, scope: item.level })),
      ...rules.flatMap((item) => [
        { path: item.ruleFile, artifactType: 'memory-rule' as const, scope: w.regLevel },
        { path: item.memoryFile, artifactType: 'memory-reference' as const, scope: w.regLevel },
      ]),
    ])
    emit({ type: 'stdout', id: 'write-rule', chunk: 'Recorded installer ownership manifest for safe future cleanup.\n' })
  }
  emit({ type: 'done', ok: true })
}

/** Parse a .env file body into a flat map (for loading into the child env). */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return out
}
