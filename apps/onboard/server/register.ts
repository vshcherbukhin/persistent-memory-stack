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
import { dirname, join } from 'node:path'

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

/** Top-level `mcpServers["persistent-memory"]` (Claude CLI global, Claude Desktop). */
export function mergeClaudeJsonGlobal(json: Json, entry: McpServerEntry): Json {
  return { ...json, mcpServers: { ...(json?.mcpServers ?? {}), [SERVER_KEY]: entry } }
}

/** `projects[projectPath].mcpServers["persistent-memory"]` (Claude CLI project scope). */
export function mergeClaudeJsonProject(json: Json, projectPath: string, entry: McpServerEntry): Json {
  const projects: Json = json?.projects ?? {}
  const proj: Json = projects[projectPath] ?? {}
  return {
    ...json,
    projects: {
      ...projects,
      [projectPath]: { ...proj, mcpServers: { ...(proj.mcpServers ?? {}), [SERVER_KEY]: entry } },
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

/** A header line belonging to OUR table or its subtables. */
function isOurHeader(trimmed: string): boolean {
  return /^\[mcp_servers\.(persistent-memory|"persistent-memory")(\.|\])/.test(trimmed)
}

/**
 * Idempotently splice our `[mcp_servers.persistent-memory]` table into an
 * existing config.toml. Only OUR table region is touched (from our header
 * through any `.env`/`.tools` subtables, up to the next foreign top-level
 * header or EOF) — comments, ordering, and neighbor tables are preserved.
 */
export function mergeCodexToml(text: string, block: string): string {
  const lines = text.split('\n')
  const startIdx = lines.findIndex((l) => {
    const t = l.trim()
    return t === `[mcp_servers.${SERVER_KEY}]` || t === `[mcp_servers."${SERVER_KEY}"]`
  })
  const blockBody = block.replace(/\n+$/, '')

  if (startIdx === -1) {
    const base = text.replace(/\s+$/, '')
    return (base === '' ? '' : base + '\n\n') + blockBody + '\n'
  }

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (t.startsWith('[') && !isOurHeader(t)) { endIdx = i; break }
  }
  const before = lines.slice(0, startIdx).join('\n').replace(/\s+$/, '')
  const after = lines.slice(endIdx).join('\n').replace(/^\s+/, '')
  const head = before === '' ? '' : before + '\n\n'
  const tail = after === '' ? '' : '\n\n' + after.replace(/\s+$/, '')
  return head + blockBody + tail + '\n'
}

// ── Path helpers (pure given homedir) ──────────────────────────────────────────

export const claudeJsonPath = (home: string): string => join(home, '.claude.json')
export const claudeDesktopConfigPath = (home: string): string =>
  join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
export const codexConfigPath = (home: string): string => join(home, '.codex', 'config.toml')
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

export function planRegistration(o: { apps: RegApps; level: 'global' | 'project'; projectPaths: string[]; home: string; mcpRuntime?: 'stream' | 'node' }): RegPlan {
  const folders = o.projectPaths.filter((p) => p.trim())
  const project = o.level === 'project' && folders.length > 0
  const writes: RegWrite[] = []
  // ~/.claude.json — Claude Code CLI + Claude Desktop folder/agent sessions (directory-aware).
  if (o.apps.claudeCli || o.apps.claudeDesktop) {
    writes.push({
      kind: 'claude',
      path: claudeJsonPath(o.home),
      level: project ? 'project' : 'global',
      clientName: 'claude-code',
      projectPaths: folders,
      label: project
        ? `~/.claude.json → projects: ${folders.join(', ')} (Claude Code + Desktop folder sessions)`
        : '~/.claude.json (global — Claude Code + Desktop)',
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
      writes.push({ kind: 'codex', path: codexConfigPath(o.home), level: 'global', clientName: codexClientName, label: `~/.codex/config.toml (${codexSurface} global)` })
    }
  }
  return { writes }
}

// ── IO writers (thin; read → merge → write 0o600) ─────────────────────────────

function readJson(path: string): Json {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json
  } catch {
    return {}
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
  let json = readJson(o.path)
  if (o.level === 'project' && o.projectPaths?.length) {
    for (const p of o.projectPaths) json = mergeClaudeJsonProject(json, p, o.entry)
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
