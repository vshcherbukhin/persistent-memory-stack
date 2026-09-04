/**
 * persistent-memory-onboard — prerequisite probe PARSERS (pure; the IO lives in
 * index.ts). Each takes raw command output and returns a structured result the
 * wizard renders with a fix hint.
 */

export interface ProbeResult {
  ok: boolean
  detail: string
}

export interface ToolProbeResult extends ProbeResult {
  installed?: boolean
  running?: boolean
  path?: string | null
}

export type PrereqComponent = 'homebrew' | 'node' | 'docker' | 'compose' | 'ollama'

export interface PrereqInstallHostState {
  platform: NodeJS.Platform | string
  brewPath: string | null
  hasDocker: boolean
  hasCompose?: boolean
  hasOllama: boolean
}

export interface PrereqInstallStep {
  id: string
  name: string
  cmd: string[]
  env?: Record<string, string>
  detached?: boolean
}

export const HOMEBREW_INSTALL_URL = 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'

export interface HomebrewManualInstallCommands {
  installCommand: string
  pathCommand: string
  activateCommand: string
  brewPath: string
}

export function homebrewManualInstallCommands(arch: NodeJS.Architecture | string = process.arch): HomebrewManualInstallCommands {
  const brewPath = arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
  const shellenv = `eval "$(${brewPath} shellenv)"`
  return {
    installCommand: `/bin/bash -c "$(curl -fsSL ${HOMEBREW_INSTALL_URL})"`,
    pathCommand: `echo '${shellenv}' >> ~/.zprofile`,
    activateCommand: shellenv,
    brewPath,
  }
}

export function buildPrereqInstallPlan(
  component: PrereqComponent,
  host: PrereqInstallHostState,
): PrereqInstallStep[] {
  if (host.platform !== 'darwin') {
    throw new Error(`Automatic ${component} installation is not supported on ${host.platform}.`)
  }

  const steps: PrereqInstallStep[] = []
  const needsBrew =
    component === 'homebrew' ||
    component === 'node' ||
    ((component === 'docker' || component === 'compose') && (!host.hasDocker || (component === 'compose' && !host.hasCompose))) ||
    (component === 'ollama' && !host.hasOllama)
  if (needsBrew && !host.brewPath) {
    throw new Error('Install Homebrew manually in Terminal, then run the environment pre-check again before using brew-backed install actions.')
  }

  if (component === 'homebrew') {
    throw new Error('Install Homebrew manually in Terminal, then run the environment pre-check again.')
  }

  const brew = host.brewPath ?? 'brew'
  if (component === 'node') {
    steps.push({
      id: 'install-node',
      name: 'Install Node 20',
      cmd: [brew, 'install', 'node@20'],
    })
    steps.push({
      id: 'link-node',
      name: 'Link Node 20',
      cmd: [brew, 'link', '--overwrite', '--force', 'node@20'],
    })
    return steps
  }

  if ((component === 'docker' || component === 'compose') && (!host.hasDocker || (component === 'compose' && !host.hasCompose))) {
    steps.push({
      id: 'install-docker',
      name: 'Install Docker Desktop',
      cmd: [brew, 'install', '--cask', 'docker-desktop'],
    })
  }
  if (component === 'docker' || component === 'compose') {
    steps.push({
      id: 'start-docker',
      name: 'Start Docker Desktop',
      cmd: ['open', '-a', 'Docker'],
      detached: true,
    })
  }

  if (component === 'ollama' && !host.hasOllama) {
    steps.push({
      id: 'install-ollama',
      name: 'Install Ollama',
      cmd: [brew, 'install', 'ollama'],
    })
  }
  if (component === 'ollama' && !host.hasOllama) {
    steps.push({
      id: 'start-ollama',
      name: 'Start Ollama',
      cmd: [brew, 'services', 'start', 'ollama'],
    })
  }
  if (component === 'ollama' && host.hasOllama) {
    steps.push({
      id: 'start-ollama',
      name: 'Start Ollama',
      cmd: ['ollama', 'serve'],
      detached: true,
    })
  }

  return steps
}

/** `docker info` succeeds + reports a server only when the daemon is running. */
export function parseDockerInfo(stdout: string, exitCode: number): ProbeResult {
  if (exitCode !== 0 || /Cannot connect to the Docker daemon|ERROR/i.test(stdout)) {
    return { ok: false, detail: 'Docker daemon is not running — start Docker Desktop / the docker service.' }
  }
  return { ok: true, detail: 'Docker daemon is running.' }
}

/** `docker compose version` → require Compose v2 (the "docker compose" subcommand). */
export function parseComposeVersion(stdout: string, exitCode: number): ProbeResult {
  const m = /version v?(\d+)\.(\d+)\.(\d+)/i.exec(stdout)
  if (exitCode !== 0 || !m) {
    return { ok: false, detail: 'Docker Compose v2 not found — install/upgrade Docker Desktop (the `docker compose` plugin).' }
  }
  const major = Number(m[1])
  return major >= 2
    ? { ok: true, detail: `Docker Compose v${m[1]}.${m[2]}.${m[3]}.` }
    : { ok: false, detail: `Docker Compose v${m[1]} is too old; v2+ required.` }
}

/** `node -v` → require Node 20+. */
export function parseNodeVersion(stdout: string): ProbeResult {
  const m = /v(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim())
  if (!m) return { ok: false, detail: 'Node not found.' }
  const major = Number(m[1])
  return major >= 20
    ? { ok: true, detail: `Node v${m[1]}.${m[2]}.${m[3]}.` }
    : { ok: false, detail: `Node v${m[1]} is too old; v20+ required.` }
}

export function parseCommandPresence(label: string, stdout: string, exitCode: number): ToolProbeResult {
  const found = exitCode === 0 && stdout.trim().length > 0
  return found
    ? { ok: true, installed: true, running: true, path: stdout.trim(), detail: `${label} found at ${stdout.trim()}.` }
    : { ok: false, installed: false, running: false, path: null, detail: `${label} not found.` }
}

export interface OllamaModel {
  name: string
}

/** Parse the host Ollama `/api/tags` JSON → the pulled model list. */
export function parseOllamaTags(json: unknown): OllamaModel[] {
  if (!json || typeof json !== 'object') return []
  const models = (json as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  return models
    .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string')
    .map((name) => ({ name }))
}

/** Is a model pulled? Ollama tags carry a ":tag" (default ":latest"); match either form. */
export function hasModel(models: OllamaModel[], wanted: string): boolean {
  const norm = (n: string) => (n.includes(':') ? n : `${n}:latest`)
  const want = norm(wanted)
  return models.some((m) => norm(m.name) === want || m.name === wanted)
}
