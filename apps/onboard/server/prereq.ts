/**
 * persistent-memory-onboard — prerequisite probe PARSERS (pure; the IO lives in
 * index.ts). Each takes raw command output and returns a structured result the
 * wizard renders with a fix hint.
 */
import { win32 } from 'node:path'

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
  root?: string
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
  if (host.platform === 'win32' && component === 'ollama') {
    return [{
      id: host.hasOllama ? 'start-ollama' : 'install-ollama',
      name: host.hasOllama ? 'Start Ollama' : 'Download, verify, and install Ollama',
      cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', win32.join(host.root ?? process.cwd(), 'deploy', 'scripts', 'install-ollama-windows.ps1'),
        '-Action', host.hasOllama ? 'Start' : 'Install'],
    }]
  }
  if (host.platform !== 'darwin') {
    throw new Error(manualPrereqHint(component, host.platform))
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
      name: 'Install Node 24',
      cmd: [brew, 'install', 'node@24'],
    })
    steps.push({
      id: 'link-node',
      name: 'Link Node 24',
      cmd: [brew, 'link', '--overwrite', '--force', 'node@24'],
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

/** Per-component capabilities: Windows Ollama does not require Homebrew/WinGet. */
export function prereqInstallCapabilities(platform: string): Record<PrereqComponent, boolean> {
  return {
    homebrew: false,
    node: platform === 'darwin',
    docker: platform === 'darwin',
    compose: platform === 'darwin',
    ollama: platform === 'darwin' || platform === 'win32',
  }
}

/** Actionable manual setup for hosts without Homebrew-managed installs. */
export function manualPrereqHint(component: PrereqComponent, platform: string): string {
  const restart = platform === 'win32' ? ' Reopen PowerShell and restart the installer after installing.' : ' Restart the installer after installing.'
  if (component === 'homebrew') return 'Homebrew is only used for automatic prerequisite installation on macOS.'
  if (component === 'node') return `Install Node.js 22.12+ (Node 24 LTS recommended) with npm from https://nodejs.org/.${restart}`
  if (component === 'docker' || component === 'compose') return platform === 'win32'
    ? 'Install Docker Desktop for Windows from https://docs.docker.com/desktop/setup/install/windows-install/, enable its WSL 2 backend, start Docker Desktop and select Linux containers. Docker Compose v2 is included.'
    : 'Install and start Docker Engine or Docker Desktop with Linux containers and Docker Compose v2.'
  return platform === 'win32'
    ? `Install and open Ollama for Windows from https://ollama.com/download/windows. Keep Ollama running for host embeddings.${restart}`
    : 'Install and start Ollama from https://ollama.com/download.'
}

/** `docker info --format {{.OSType}}` must report a running Linux engine. */
export function parseDockerInfo(stdout: string, exitCode: number): ProbeResult {
  if (exitCode !== 0 || /Cannot connect to the Docker daemon|ERROR/i.test(stdout)) {
    return { ok: false, detail: 'Docker daemon is not running — start Docker Desktop / the docker service.' }
  }
  const type = stdout.trim().toLowerCase()
  if (type === 'windows' || /ostype:\s*windows/i.test(stdout)) {
    return { ok: false, detail: 'Docker is using Windows containers. Switch Docker Desktop to Linux containers, then check again.' }
  }
  if (type !== 'linux' && !/ostype:\s*linux/i.test(stdout)) {
    return { ok: false, detail: 'Could not confirm a Linux Docker engine. Start Docker Desktop with Linux containers, then check again.' }
  }
  return { ok: true, detail: 'Docker Linux engine is running.' }
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

/** `node -v` → require Node 22.12+ (toolchain minimum). */
export function parseNodeVersion(stdout: string): ProbeResult {
  const m = /v(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim())
  if (!m) return { ok: false, detail: 'Node not found.' }
  const major = Number(m[1])
  return (major >= 24 || (major === 22 && Number(m[2]) >= 12))
    ? { ok: true, detail: `Node v${m[1]}.${m[2]}.${m[3]}.` }
    : { ok: false, detail: `Node v${m[1]}.${m[2]} is unsupported; use v22.12+ on Node 22 or Node 24+.` }
}

export function parseCommandPresence(label: string, stdout: string, exitCode: number): ToolProbeResult {
  const found = exitCode === 0 && stdout.trim().length > 0
  return found
    ? { ok: true, installed: true, running: true, path: stdout.trim().split(/\r?\n/)[0]!, detail: `${label} found at ${stdout.trim().split(/\r?\n/)[0]}.` }
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
