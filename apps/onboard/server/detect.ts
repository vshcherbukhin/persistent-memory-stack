/**
 * persistent-memory-onboard — system + ecosystem detection.
 *
 * Pure functions (recommendModel/detectApps/bytesToGB) are unit-tested; the IO
 * wrappers (readSpecs/readApps) live at the bottom and only gather `os.*` +
 * `existsSync` results to feed the pure core. The wizard uses these for smart
 * defaults: a spec-matched "recommended" embedding model (Flow 1) and a checklist
 * limited to the agent apps actually installed.
 */
import os from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { agentProfiles } from './agent-profiles.js'

export interface SysSpecs {
  totalMemGB: number
}

export interface ModelRec {
  model: string
  dim: number
}

/** GB to one decimal (1 GB = 1e9 bytes, matching how RAM is marketed/shown). */
export function bytesToGB(bytes: number): number {
  return Math.round((bytes / 1e9) * 10) / 10
}

/**
 * Recommended LOCAL embedding model by RAM tier. Flow 1 only (the pick defines
 * the server pin). 4b is the default sweet spot; 8b needs real headroom, 0.6b is
 * the CPU-friendly floor. Dims are the registry natives (see shared registry).
 */
export function recommendModel(specs: SysSpecs): ModelRec {
  if (specs.totalMemGB >= 64) return { model: 'qwen3-embedding:8b', dim: 4096 }
  if (specs.totalMemGB >= 16) return { model: 'qwen3-embedding:4b', dim: 2560 }
  return { model: 'qwen3-embedding:0.6b', dim: 1024 }
}

export interface AppProbes {
  claudeJson: boolean // ~/.claude.json (Claude CLI)
  claudeDesktopCfg: boolean // ~/Library/Application Support/Claude/claude_desktop_config.json
  claudeApp: boolean // /Applications/Claude.app
  codexToml: boolean // ~/.codex/config.toml (Codex CLI + Desktop share this)
  codexApp: boolean // /Applications/Codex.app
}

export interface AppDetection {
  claudeCli: boolean
  claudeDesktop: boolean
  codexCli: boolean
  codexDesktop: boolean
}

/** Map raw path-existence probes → which agent ecosystems are present. */
export function detectApps(p: AppProbes): AppDetection {
  return {
    claudeCli: p.claudeJson,
    claudeDesktop: p.claudeDesktopCfg || p.claudeApp,
    codexCli: p.codexToml,
    codexDesktop: p.codexApp,
  }
}

// ── IO wrappers (not unit-tested; thin) ───────────────────────────────────────

export interface AppPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/** Explicit platform paths make detection portable and deterministic in tests. */
export function appProbePaths(home: string, options: AppPathOptions = {}): Record<keyof AppProbes, string> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const path = platform === 'win32' ? win32 : posix
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const profiles = agentProfiles(home, { platform, env })
  return {
    claudeJson: profiles.claudeJson,
    claudeDesktopCfg: profiles.claudeDesktopConfig,
    claudeApp: platform === 'win32' ? path.join(local, 'AnthropicClaude', 'claude.exe') : platform === 'darwin' ? '/Applications/Claude.app' : '',
    codexToml: profiles.codexConfig,
    codexApp: platform === 'win32' ? path.join(local, 'Programs', 'Codex', 'Codex.exe') : platform === 'darwin' ? '/Applications/Codex.app' : '',
  }
}

export function readSpecs(): SysSpecs & { cpus: number; recommended: ModelRec } {
  const totalMemGB = bytesToGB(os.totalmem())
  return { totalMemGB, cpus: os.cpus().length, recommended: recommendModel({ totalMemGB }) }
}

function subdirectories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) } catch { return [] }
}

export function readApps(home = homedir(), options: AppPathOptions = {}, exists: (path: string) => boolean = existsSync, directories: (path: string) => string[] = subdirectories): AppDetection & { paths: Record<keyof AppProbes, string> } {
  const paths = appProbePaths(home, options)
  const probes = Object.fromEntries(
    Object.entries(paths).map(([k, v]) => [k, !!v && exists(v)]),
  ) as unknown as AppProbes
  if ((options.platform ?? process.platform) === 'win32') {
    const env = options.env ?? process.env
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
    probes.claudeApp ||= exists(win32.join(local, 'Programs', 'Claude', 'Claude.exe'))
    probes.codexApp ||= exists(win32.join(local, 'Microsoft', 'WindowsApps', 'Codex.exe'))
    if (!probes.codexApp) {
      const bin = win32.join(local, 'OpenAI', 'Codex', 'bin')
      const executable = directories(bin).map((build) => win32.join(bin, build, 'codex.exe')).find(exists)
      if (executable) {
        paths.codexApp = executable
        probes.codexApp = true
      }
    }
  }
  return { ...detectApps(probes), paths }
}
