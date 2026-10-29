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

export const PREREQ_COMPONENTS = ['homebrew', 'node', 'npm', 'git', 'bash', 'docker', 'compose', 'buildx', 'ollama'] as const
export type PrereqComponent = typeof PREREQ_COMPONENTS[number]

export interface PrereqInstallHostState {
  platform: NodeJS.Platform | string
  brewPath: string | null
  hasDocker: boolean
  hasCompose?: boolean
  hasOllama: boolean
  root?: string
  wingetPath?: string | null
  node24Version?: string | null
  dockerDesktopPath?: string | null
  hasDockerDesktop?: boolean
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
  if (!PREREQ_COMPONENTS.includes(component)) throw new Error('Unknown prerequisite action.')
  if (host.platform === 'win32' && component === 'ollama') {
    return [{
      id: host.hasOllama ? 'start-ollama' : 'install-ollama',
      name: host.hasOllama ? 'Start Ollama' : 'Download, verify, and install Ollama',
      cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', win32.join(host.root ?? process.cwd(), 'deploy', 'scripts', 'install-ollama-windows.ps1'),
        '-Action', host.hasOllama ? 'Start' : 'Install'],
    }]
  }
  if (host.platform === 'win32') {
    if (component === 'homebrew') throw new Error(manualPrereqHint(component, host.platform))
    const docker = component === 'docker' || component === 'compose' || component === 'buildx'
    if (docker && component === 'docker' && host.hasDockerDesktop && host.dockerDesktopPath) {
      return [{ id: 'start-docker', name: 'Start Docker Desktop', cmd: [host.dockerDesktopPath], detached: true }]
    }
    if (!host.wingetPath) throw new Error(`${manualPrereqHint(component, host.platform)} WinGet is unavailable, so setup cannot run an automatic install.`)
    const node = component === 'node' || component === 'npm'
    if (node && !/^24\.\d+\.\d+$/.test(host.node24Version ?? '')) throw new Error('A supported Node 24 version could not be resolved from WinGet. Install Node 24.x manually and restart setup.')
    const id = node ? 'OpenJS.NodeJS.LTS' : docker ? 'Docker.DockerDesktop' : 'Git.Git'
    const steps: PrereqInstallStep[] = [{
      id: `install-${component}`, name: `${docker && host.hasDocker ? 'Update' : 'Install'} ${node ? 'Node 24 with npm' : docker ? 'Docker Desktop' : 'Git for Windows'}`,
      cmd: [host.wingetPath, docker && host.hasDocker ? 'upgrade' : 'install', '--id', id, '--exact', '--source', 'winget',
        ...(node ? ['--version', host.node24Version!] : []), '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
    }]
    if (docker && host.dockerDesktopPath) steps.push({ id: 'start-docker', name: 'Start Docker Desktop', cmd: [host.dockerDesktopPath], detached: true })
    return steps
  }
  if (host.platform !== 'darwin') {
    throw new Error(manualPrereqHint(component, host.platform))
  }

  const steps: PrereqInstallStep[] = []
  const needsBrew =
    component === 'homebrew' ||
    component === 'node' || component === 'npm' || component === 'git' || component === 'bash' ||
    ((component === 'docker' || component === 'compose' || component === 'buildx') && (!host.hasDocker || component !== 'docker')) ||
    (component === 'ollama' && !host.hasOllama)
  if (needsBrew && !host.brewPath) {
    throw new Error('Install Homebrew manually in Terminal, then run the environment pre-check again before using brew-backed install actions.')
  }

  if (component === 'homebrew') {
    throw new Error('Install Homebrew manually in Terminal, then run the environment pre-check again.')
  }

  const brew = host.brewPath ?? 'brew'
  if (component === 'node' || component === 'npm') {
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
  if (component === 'git' || component === 'bash') return [{ id: `install-${component}`, name: `Install ${component === 'git' ? 'Git' : 'Bash and curl'}`, cmd: [brew, 'install', component, ...(component === 'bash' ? ['curl'] : [])] }]

  if ((component === 'docker' || component === 'compose' || component === 'buildx') && (!host.hasDocker || component !== 'docker')) {
    steps.push({
      id: 'install-docker',
      name: host.hasDocker ? 'Update Docker Desktop' : 'Install Docker Desktop',
      cmd: [brew, host.hasDocker ? 'upgrade' : 'install', '--cask', 'docker-desktop'],
    })
  }
  if (component === 'docker' || component === 'compose' || component === 'buildx') {
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
export function prereqInstallCapabilities(platform: string, options: { winget?: boolean; dockerDesktop?: boolean } = {}): Record<PrereqComponent, boolean> {
  const packageManager = platform === 'darwin' || (platform === 'win32' && options.winget === true)
  return {
    homebrew: false,
    node: packageManager,
    npm: packageManager,
    git: packageManager,
    bash: packageManager,
    docker: packageManager || (platform === 'win32' && options.dockerDesktop === true),
    compose: packageManager,
    buildx: packageManager,
    ollama: platform === 'darwin' || platform === 'win32',
  }
}

/** Actionable manual setup for hosts without Homebrew-managed installs. */
export function manualPrereqHint(component: PrereqComponent, platform: string): string {
  const restart = platform === 'win32' ? ' Reopen PowerShell and restart the installer after installing.' : ' Restart the installer after installing.'
  if (component === 'homebrew') return 'Homebrew is only used for automatic prerequisite installation on macOS.'
  if (component === 'node' || component === 'npm') return `Install Node.js 24.x or Node 22.12+ within 22.x with npm 10.x or 11.x from https://nodejs.org/. Other major versions are not validated by this application.${restart}`
  if (component === 'git' || component === 'bash') return platform === 'win32' ? `Install Git for Windows from https://git-scm.com/downloads/win; setup needs its native Git Bash, not WSL.${restart}` : `Install Git and native Bash with your operating system's package manager.${restart}`
  if (component === 'docker' || component === 'compose' || component === 'buildx') return platform === 'win32'
    ? 'Install Docker Desktop for Windows from https://docs.docker.com/desktop/setup/install/windows-install/, enable its WSL 2 backend, start Docker Desktop and select Linux containers. Compose 2.24.4+ and Buildx are required.'
    : 'Install and start Docker Engine or Docker Desktop with Linux containers, Compose 2.24.4+ and Buildx.'
  return platform === 'win32'
    ? `Install and open Ollama for Windows from https://ollama.com/download/windows. Keep Ollama running for host embeddings.${restart}`
    : 'Install and start Ollama from https://ollama.com/download.'
}

/** Select only stable24.x metadata; never install the upstream LTS alias blindly. */
export function node24FromWingetVersions(output: string): string | null {
  const versions = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^24\.\d+\.\d+$/.test(line))
  return versions.sort((a, b) => {
    const aa = a.split('.').map(Number); const bb = b.split('.').map(Number)
    return bb[1]! - aa[1]! || bb[2]! - aa[2]!
  })[0] ?? null
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

export const MINIMUM_COMPOSE_VERSION = '2.24.4'

/** Application-tested floor; vendor Desktop suffixes are accepted, prereleases are not. */
export function parseComposeVersion(stdout: string, exitCode: number): ProbeResult {
  const m = /version v?(\d+)\.(\d+)\.(\d+)([^\s]*)/i.exec(stdout)
  if (exitCode !== 0 || !m) {
    return { ok: false, detail: `Docker Compose ${MINIMUM_COMPOSE_VERSION}+ was not found. Install or update Docker Desktop/the Compose plugin.` }
  }
  const major = Number(m[1])
  const supported = (major > 2 || (major === 2 && (Number(m[2]) > 24 || (Number(m[2]) === 24 && Number(m[3]) >= 4)))) &&
    /^(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(m[4] ?? '') && !/-(?:rc|alpha|beta|dev)/i.test(m[4] ?? '')
  return supported
    ? { ok: true, detail: `Docker Compose v${m[1]}.${m[2]}.${m[3]}.` }
    : { ok: false, detail: `Docker Compose ${m[1]}.${m[2]}.${m[3]} is outside the tested requirement; ${MINIMUM_COMPOSE_VERSION}+ stable is required.` }
}

/** Supported host lines, not every version accepted by a dependency's engine range. */
export function parseNodeVersion(stdout: string): ProbeResult {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(stdout.trim())
  if (!m) return { ok: false, detail: 'Node not found.' }
  const major = Number(m[1])
  return (major === 24 || (major === 22 && Number(m[2]) >= 12))
    ? { ok: true, detail: `Node v${m[1]}.${m[2]}.${m[3]}.` }
    : { ok: false, detail: `This installer is running Node v${m[1]}.${m[2]}.${m[3]}. Use Node 24.x or Node 22.12+ within 22.x, then restart the installer. Other major versions are not validated by this application.` }
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
