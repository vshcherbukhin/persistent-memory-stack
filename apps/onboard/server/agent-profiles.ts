import { posix, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import { nativeWindowsPath } from './host.js'

export interface AgentProfileOptions {
  platform?: NodeJS.Platform
  /** Explicit host profile variables; never inferred by pure path builders. */
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

export function agentProfileEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'XDG_CONFIG_HOME']
    .filter(key => env[key]).map(key => [key, env[key]]))
}

export function agentProfiles(home: string, options: AgentProfileOptions = {}) {
  const platform = options.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const env = options.env ?? {}
  const directory = (key: string, fallback: string): string => {
    const value = env[key]?.trim()
    if (!value) return fallback
    const expanded = /^~[\\/]/.test(value) ? path.join(home, value.slice(2)) : value
    const native = platform === 'win32' ? nativeWindowsPath(expanded) : expanded
    if (!path.isAbsolute(native)) throw new Error(`${key} must name an absolute directory. Set it before launching the installer.`)
    return path.normalize(native)
  }
  const claudeDir = directory('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
  const codexDir = directory('CODEX_HOME', path.join(home, '.codex'))
  const legacyClaudeJson = path.join(claudeDir, '.config.json')
  return {
    claudeDir,
    // Claude relocates its global JSON inside an explicitly selected profile;
    // the default remains the sibling ~/.claude.json, not ~/.claude/.claude.json.
    claudeJson: (options.exists ?? existsSync)(legacyClaudeJson)
      ? legacyClaudeJson : path.join(env.CLAUDE_CONFIG_DIR?.trim() ? claudeDir : home, '.claude.json'),
    codexDir,
    codexConfig: path.join(codexDir, 'config.toml'),
    claudeDesktopConfig: platform === 'win32'
      ? path.join(directory('APPDATA', path.join(home, 'AppData', 'Roaming')), 'Claude', 'claude_desktop_config.json')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(directory('XDG_CONFIG_HOME', path.join(home, '.config')), 'Claude', 'claude_desktop_config.json'),
  }
}

export function normalizedProjectPaths(paths: string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>()
  return paths.flatMap(value => {
    const trimmed = value.trim()
    if (!trimmed) return []
    const native = platform === 'win32' && /^(?:[a-z]:[\\/]|\/[a-z]\/|\\\\)/i.test(trimmed)
      ? win32.normalize(nativeWindowsPath(trimmed)) : trimmed
    const path = platform === 'win32' ? win32 : posix
    if (!path.isAbsolute(native)) throw new Error('Project registration requires an absolute folder path. Use Choose or enter its full path.')
    const key = platform === 'win32' ? win32.normalize(native).toLowerCase() : posix.normalize(native)
    if (seen.has(key)) return []
    seen.add(key)
    return [native]
  })
}
