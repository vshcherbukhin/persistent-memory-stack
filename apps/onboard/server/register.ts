/**
 * persistent-memory-onboard — MCP registration into agent-app configs.
 *
 * Pure builders + idempotent mergers (unit-tested, never touch disk): they take
 * the CURRENT file object/text and return the new one. The thin `*Write` IO
 * wrappers at the bottom do read→merge→write (mode 0o600). Targets:
 *   • Claude CLI      ~/.claude.json  (global top-level OR projects.<path>.mcpServers)
 *   • Claude Desktop folder sessions via ~/.claude.json. Standalone Desktop chat
 *     uses Custom Connectors for Streamable HTTP; the installer does not write
 *     to claude_desktop_config.json.
 *   • Codex CLI/Desktop ~/.codex/config.toml  [mcp_servers.persistent-memory] (global)
 *
 * The MCP entry NEVER carries EMBEDDING_MODE — the MCP learns the mode from the
 * server's GET /config (see apps/mcp/CLAUDE_MCP_SETUP.md §4).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { agentProfiles, normalizedProjectPaths, type AgentProfileOptions } from './agent-profiles.js'
import { mergeCodexToml } from './mcp-toml.js'
export { mergeCodexToml } from './mcp-toml.js'

const SERVER_KEY = 'persistent-memory'

export interface McpServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'http'
  url?: string
}

export interface McpEntryOpts {
  /** @deprecated Legacy runtime input is a migration alias. Registration is always stream. */
  mcpRuntime: 'stream' | 'node'
  apiUrl: string
  ollamaUrl: string
  token: string
  /** Deprecated launcher path retained only so older callers type-check. */
  wrapperPath: string
  /** Streamable HTTP MCP endpoint for the shared service. */
  streamUrl: string
  /** Deprecated client label retained only so older callers type-check. */
  clientName?: string
  memoryInstallMode?: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface?: 'personal' | 'shared'
  personalApiUrl?: string
  personalUserToken?: string
  sharedApiUrl?: string
  sharedUserToken?: string
}

/** Build the canonical Streamable HTTP MCP entry. Tokens and surface routing live
 * in the local stack / stream service, not in agent config files. */
export function buildMcpEntry(o: McpEntryOpts): McpServerEntry {
  return { type: 'http', url: o.streamUrl }
}

// ── Claude (~/.claude.json + Desktop config) — JSON, deep-merge by key ─────────

type Json = Record<string, any>

function jsonObject(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object; existing configuration was not changed.`)
  return value as Json
}

/** Top-level `mcpServers["persistent-memory"]` (Claude CLI global, Claude Desktop). */
export function mergeClaudeJsonGlobal(json: Json, entry: McpServerEntry): Json {
  jsonObject(json, 'Claude configuration')
  return { ...json, mcpServers: { ...jsonObject(json.mcpServers === undefined ? {} : json.mcpServers, 'mcpServers'), [SERVER_KEY]: entry } }
}

/** `projects[projectPath].mcpServers["persistent-memory"]` (Claude CLI project scope). */
export function mergeClaudeJsonProject(json: Json, projectPath: string, entry: McpServerEntry): Json {
  jsonObject(json, 'Claude configuration')
  const projects = jsonObject(json.projects === undefined ? {} : json.projects, 'projects')
  // Windows tools may save the same directory with different separators/case.
  // Reuse an existing key to retain its trust state and unrelated MCP entries.
  const comparable = (value: string) => win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
  const key = process.platform === 'win32'
    ? Object.keys(projects).find(key => comparable(key) === comparable(projectPath)) ?? projectPath
    : projectPath
  const proj = jsonObject(projects[key] === undefined ? {} : projects[key], `projects entry`)
  return {
    ...json,
    projects: {
      ...projects,
      [key]: { ...proj, mcpServers: { ...jsonObject(proj.mcpServers === undefined ? {} : proj.mcpServers, 'project mcpServers'), [SERVER_KEY]: entry } },
    },
  }
}

// ── Codex (~/.codex/config.toml) — surgical, no TOML library ───────────────────

function tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Emit the `[mcp_servers.persistent-memory]` table (+ `.env` subtable). */
export function buildCodexBlock(entry: McpServerEntry): string {
  const lines: string[] = [`[mcp_servers.${SERVER_KEY}]`]
  if (entry.url) {
    lines.push(`url = ${tomlStr(entry.url)}`)
    return lines.join('\n') + '\n'
  }
  if (!entry.command) throw new Error('legacy command MCP entries are no longer generated.')
  lines.push(`command = ${tomlStr(entry.command)}`)
  if (entry.args && entry.args.length) {
    lines.push(`args = [${entry.args.map(tomlStr).join(', ')}]`)
  }
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push('', `[mcp_servers.${SERVER_KEY}.env]`)
    for (const [k, v] of Object.entries(entry.env)) lines.push(`${k} = ${tomlStr(v)}`)
  }
  return lines.join('\n') + '\n'
}

// ── Path helpers (pure given homedir) ──────────────────────────────────────────

export const claudeJsonPath = (home: string, options?: AgentProfileOptions): string => agentProfiles(home, options).claudeJson
export const claudeDesktopConfigPath = (home: string, options?: AgentProfileOptions): string => agentProfiles(home, options).claudeDesktopConfig
export const codexConfigPath = (home: string, options?: AgentProfileOptions): string => agentProfiles(home, options).codexConfig
export const codexProjectConfigPath = (projectDir: string): string => join(projectDir, '.codex', 'config.toml')

// ── Registration PLAN (pure) — selected apps + scope → the exact writes ─────────
// MCP scope is DIRECTORY-AWARE (code.claude.com/docs/en/mcp): ~/.claude.json (top-level OR
// projects.<path>.mcpServers) is read by Claude Code CLI AND Claude Desktop folder/agent (Cowork)
// sessions; claude_desktop_config.json is ONLY the standalone Desktop chat (global).
// Codex CLI and Desktop are separate wizard choices but share ~/.codex/config.toml
// (global) OR <project>/.codex/config.toml (project, once the folder is trusted).
export interface RegWrite {
  kind: 'claude' | 'codex'
  path: string
  level: 'global' | 'project'
  clientName: string
  projectPaths?: string[]
  label: string
}
export interface RegApps { claudeCli: boolean; claudeDesktop: boolean; codexCli: boolean; codexDesktop: boolean }
export interface RegPlan { writes: RegWrite[] }

export function planRegistration(o: { apps: RegApps; level: 'global' | 'project'; projectPaths: string[]; home: string; profileEnv?: NodeJS.ProcessEnv; mcpRuntime?: 'stream' | 'node' }): RegPlan {
  const folders = o.level === 'project' ? normalizedProjectPaths(o.projectPaths) : []
  const project = o.level === 'project'
  if (project && folders.length === 0) throw new Error('Project registration requires at least one absolute folder path.')
  const writes: RegWrite[] = []
  // ~/.claude.json — Claude Code CLI + Claude Desktop folder/agent sessions (directory-aware).
  if (o.apps.claudeCli || o.apps.claudeDesktop) {
    writes.push({
      kind: 'claude',
      path: claudeJsonPath(o.home, { env: o.profileEnv }),
      level: project ? 'project' : 'global',
      clientName: 'claude-code',
      projectPaths: folders,
      label: project
        ? `${claudeJsonPath(o.home, { env: o.profileEnv })} → projects: ${folders.join(', ')} (Claude Code + Desktop folder sessions)`
        : `${claudeJsonPath(o.home, { env: o.profileEnv })} (global — Claude Code + Desktop)`,
    })
  }
  // claude_desktop_config.json is command/stdio-shaped. Streamable HTTP belongs
  // in ~/.claude.json for folder sessions or in Claude Custom Connectors.
  // Codex — ~/.codex/config.toml (global) OR <folder>/.codex/config.toml (project; trust the folder).
  const codexSelected = o.apps.codexCli || o.apps.codexDesktop
  const codexClientName = o.apps.codexCli && o.apps.codexDesktop ? 'codex' : o.apps.codexDesktop ? 'codex-desktop' : 'codex-cli'
  const codexSurface = o.apps.codexCli && o.apps.codexDesktop ? 'Codex CLI + Desktop' : o.apps.codexDesktop ? 'Codex Desktop' : 'Codex CLI'
  if (codexSelected) {
    if (project) {
      for (const p of folders) writes.push({ kind: 'codex', path: codexProjectConfigPath(p), level: 'project', clientName: codexClientName, label: `${p}/.codex/config.toml (${codexSurface} project — trust the folder in Codex to load it)` })
    } else {
      const path = codexConfigPath(o.home, { env: o.profileEnv })
      writes.push({ kind: 'codex', path, level: 'global', clientName: codexClientName, label: `${path} (${codexSurface} global)` })
    }
  }
  return { writes }
}

// ── IO writers (thin; read → merge → write 0o600) ─────────────────────────────

export function readAgentJson(path: string): Json {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Cannot read ${path}; existing configuration was not changed.`)
  }
  try {
    return jsonObject(JSON.parse(text.replace(/^\uFEFF/, '')), 'Claude configuration')
  } catch {
    // Do not include parser messages: they can quote private config contents.
    throw new Error(`Cannot parse ${path} as a JSON object; existing configuration was not changed.`)
  }
}

function writeFile600(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode: 0o600 })
}

export interface ClaudeRegisterOpts {
  path: string
  entry: McpServerEntry
  level: 'global' | 'project'
  projectPaths?: string[]
}

/** Register into a Claude JSON config (CLI global/project, or Desktop=global). */
export function registerClaudeWrite(o: ClaudeRegisterOpts): void {
  let json = readAgentJson(o.path)
  if (o.level === 'project') {
    const projects = normalizedProjectPaths(o.projectPaths ?? [])
    if (projects.length === 0) throw new Error('Project registration requires at least one absolute folder path.')
    for (const p of projects) json = mergeClaudeJsonProject(json, p, o.entry)
  } else {
    json = mergeClaudeJsonGlobal(json, o.entry)
  }
  writeFile600(o.path, JSON.stringify(json, null, 2) + '\n')
}

/** Register into ~/.codex/config.toml (global for both Codex CLI + Desktop). */
export function registerCodexWrite(path: string, entry: McpServerEntry): void {
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFile600(path, mergeCodexToml(cur, buildCodexBlock(entry)))
}
