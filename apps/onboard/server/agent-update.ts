/**
 * Refresh already-installed agent integration artifacts during `npm run
 * update-persistent-memory`.
 *
 * The first-run wizard owns the canonical MCP registration/rule writers. The
 * update path uses this module to re-apply those generated artifacts after a
 * pull, but only where a persistent-memory install is already detectable. That
 * gives old installs new prompts/rules/registration metadata without creating
 * surprise files in unrelated Claude/Codex profiles.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMcpEntry,
  claudeDesktopConfigPath,
  claudeJsonPath,
  codexConfigPath,
  codexProjectConfigPath,
  registerClaudeWrite,
  registerCodexWrite,
  type McpServerEntry,
} from './register.js'
import {
  readDefaultRule,
  writeRuleTargets,
  type RuleTarget,
} from './rule.js'

const SERVER_KEY = 'persistent-memory'
const RULE_BASENAME = 'persistent-memory.md'

export interface RefreshAgentInstallInput {
  root: string
  home?: string
  env?: Record<string, string>
}

export interface RefreshAgentInstallResult {
  registrationWrites: number
  ruleWrites: number
  messages: string[]
}

interface DerivedAgentEnv {
  mcpRuntime: 'stream'
  streamUrl: string
  wrapperPath: string
  ollamaUrl: string
  memoryInstallMode: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface: 'personal' | 'shared'
  personalApiUrl: string
  personalUserToken?: string
  sharedApiUrl?: string
  sharedUserToken?: string
}

interface CodexEntry {
  command?: string
  url?: string
  env?: Record<string, string>
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function envValue(env: Record<string, string>, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function asRuntime(_value: string | undefined): 'stream' {
  return 'stream'
}

function asInstallMode(value: string | undefined, deploymentMode: string | undefined): DerivedAgentEnv['memoryInstallMode'] {
  if (value === 'personal-only' || value === 'personal-and-shared' || value === 'shared-only') return value
  return deploymentMode === 'local' ? 'personal-only' : 'shared-only'
}

function asSurface(value: string | undefined, mode: DerivedAgentEnv['memoryInstallMode']): 'personal' | 'shared' {
  if (value === 'personal' || value === 'shared') return value
  return mode === 'shared-only' ? 'shared' : 'personal'
}

function deriveAgentEnv(root: string, env: Record<string, string>): DerivedAgentEnv {
  const deploymentMode = envValue(env, 'DEPLOYMENT_MODE')
  const memoryInstallMode = asInstallMode(envValue(env, 'PM_MEMORY_INSTALL_MODE'), deploymentMode)
  return {
    mcpRuntime: asRuntime(envValue(env, 'PM_MCP_RUNTIME')),
    streamUrl: envValue(env, 'PM_MCP_STREAM_URL') ?? '',
    wrapperPath: join(root, 'apps', 'mcp', 'persistent-memory-mcp.sh'),
    ollamaUrl: envValue(env, 'OLLAMA_URL') ?? 'http://localhost:11434',
    memoryInstallMode,
    defaultMemorySurface: asSurface(envValue(env, 'PM_DEFAULT_MEMORY_SURFACE'), memoryInstallMode),
    personalApiUrl: envValue(env, 'PM_PERSONAL_API_URL') ?? 'http://localhost:8090',
    personalUserToken: envValue(env, 'PM_PERSONAL_USER_TOKEN'),
    sharedApiUrl: envValue(env, 'PM_SHARED_API_URL'),
    sharedUserToken: envValue(env, 'PM_SHARED_USER_TOKEN'),
  }
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  } catch {
    return null
  }
}

function existingEnv(entry: McpServerEntry | CodexEntry | undefined): Record<string, string> {
  return entry?.env ?? {}
}

function buildEntryFromExisting(existing: McpServerEntry | CodexEntry | undefined, clientName: string, derived: DerivedAgentEnv): McpServerEntry {
  const oldEnv = existingEnv(existing)

  return buildMcpEntry({
    mcpRuntime: 'stream',
    apiUrl: derived.personalApiUrl,
    ollamaUrl: oldEnv.OLLAMA_URL ?? derived.ollamaUrl,
    token: '',
    wrapperPath: derived.wrapperPath,
    streamUrl: derived.streamUrl || existing?.url || 'http://127.0.0.1:8091/mcp',
    clientName: oldEnv.PM_MCP_CLIENT_NAME ?? clientName,
    memoryInstallMode: derived.memoryInstallMode,
    defaultMemorySurface: derived.defaultMemorySurface,
    personalApiUrl: derived.personalApiUrl,
    personalUserToken: derived.personalUserToken ?? oldEnv.PM_PERSONAL_USER_TOKEN,
    sharedApiUrl: derived.sharedApiUrl ?? oldEnv.PM_SHARED_API_URL,
    sharedUserToken: derived.sharedUserToken ?? oldEnv.PM_SHARED_USER_TOKEN,
  })
}

function isOurTomlHeader(trimmed: string): boolean {
  return /^\[mcp_servers\.(persistent-memory|"persistent-memory")(\.|\])/.test(trimmed)
}

function unquoteToml(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return trimmed
}

export function readCodexPersistentMemoryEntry(text: string): CodexEntry | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => {
    const t = line.trim()
    return t === `[mcp_servers.${SERVER_KEY}]` || t === `[mcp_servers."${SERVER_KEY}"]`
  })
  if (start < 0) return null

  const entry: CodexEntry = { env: {} }
  let section: 'root' | 'env' = 'root'
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (trimmed.startsWith('[')) {
      if (!isOurTomlHeader(trimmed)) break
      section = trimmed.includes('.env]') || trimmed.includes('".env"]') ? 'env' : 'root'
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = unquoteToml(trimmed.slice(eq + 1))
    if (section === 'env') entry.env![key] = value
    else if (key === 'command') entry.command = value
    else if (key === 'url') entry.url = value
  }
  return entry
}

function ruleTarget(kind: 'claude' | 'codex', baseDir: string, memoryDir: string, memoryName: string): RuleTarget {
  return {
    kind,
    memoryFile: join(memoryDir, memoryName),
    ruleFile: join(baseDir, 'rules', RULE_BASENAME),
    ruleRef: memoryDir === baseDir ? `@rules/${RULE_BASENAME}` : `@.${kind}/rules/${RULE_BASENAME}`,
  }
}

function hasPersistentMemoryText(path: string, projectScopedKind?: 'claude' | 'codex'): boolean {
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  if (projectScopedKind) return text.includes(`@.${projectScopedKind}/rules/${RULE_BASENAME}`)
  return /Persistent Memory Usage|rules\/persistent-memory\.md|persistent-memory MCP/i.test(text)
}

function addRuleTarget(targets: Map<string, RuleTarget>, target: RuleTarget): void {
  targets.set(`${target.kind}:${target.ruleFile}:${target.memoryFile}`, target)
}

function addGlobalRuleTarget(targets: Map<string, RuleTarget>, kind: 'claude' | 'codex', home: string): void {
  if (kind === 'claude') addRuleTarget(targets, ruleTarget('claude', join(home, '.claude'), join(home, '.claude'), 'CLAUDE.md'))
  else addRuleTarget(targets, ruleTarget('codex', join(home, '.codex'), join(home, '.codex'), 'AGENTS.md'))
}

function addProjectRuleTarget(targets: Map<string, RuleTarget>, kind: 'claude' | 'codex', projectPath: string): void {
  if (kind === 'claude') addRuleTarget(targets, ruleTarget('claude', join(projectPath, '.claude'), projectPath, 'CLAUDE.md'))
  else addRuleTarget(targets, ruleTarget('codex', join(projectPath, '.codex'), projectPath, 'AGENTS.md'))
}

function discoverPromptOnlyTargets(home: string, root: string, targets: Map<string, RuleTarget>): void {
  if (existsSync(join(home, '.claude', 'rules', RULE_BASENAME)) || hasPersistentMemoryText(join(home, '.claude', 'CLAUDE.md'))) {
    addGlobalRuleTarget(targets, 'claude', home)
  }
  if (existsSync(join(home, '.codex', 'rules', RULE_BASENAME)) || hasPersistentMemoryText(join(home, '.codex', 'AGENTS.md'))) {
    addGlobalRuleTarget(targets, 'codex', home)
  }

  if (existsSync(join(root, '.claude', 'rules', RULE_BASENAME)) || hasPersistentMemoryText(join(root, 'CLAUDE.md'), 'claude')) {
    addProjectRuleTarget(targets, 'claude', root)
  }
  if (existsSync(join(root, '.codex', 'rules', RULE_BASENAME)) || hasPersistentMemoryText(join(root, 'AGENTS.md'), 'codex')) {
    addProjectRuleTarget(targets, 'codex', root)
  }
}

export function refreshAgentInstall(input: RefreshAgentInstallInput): RefreshAgentInstallResult {
  const root = input.root
  const home = input.home ?? homedir()
  const env = input.env ?? parseEnvFile(join(root, '.env.persistent-memory'))
  const derived = deriveAgentEnv(root, env)
  const messages: string[] = []
  const ruleTargets = new Map<string, RuleTarget>()
  let registrationWrites = 0

  const claudePath = claudeJsonPath(home)
  const claudeJson = readJson(claudePath)
  const claudeProjectPaths = new Set<string>()
  if (claudeJson) {
    const globalEntry = claudeJson.mcpServers?.[SERVER_KEY] as McpServerEntry | undefined
    if (globalEntry) {
      registerClaudeWrite({ path: claudePath, level: 'global', entry: buildEntryFromExisting(globalEntry, 'claude-code', derived) })
      registrationWrites++
      addGlobalRuleTarget(ruleTargets, 'claude', home)
      messages.push(`refreshed ${claudePath}`)
    }
    const projects = claudeJson.projects && typeof claudeJson.projects === 'object' ? claudeJson.projects as Record<string, any> : {}
    for (const [projectPath, project] of Object.entries(projects)) {
      const existing = project?.mcpServers?.[SERVER_KEY] as McpServerEntry | undefined
      if (!existing) continue
      registerClaudeWrite({
        path: claudePath,
        level: 'project',
        projectPaths: [projectPath],
        entry: buildEntryFromExisting(existing, 'claude-code', derived),
      })
      registrationWrites++
      claudeProjectPaths.add(projectPath)
      addProjectRuleTarget(ruleTargets, 'claude', projectPath)
      messages.push(`refreshed ${claudePath} project ${projectPath}`)
    }
  }

  const desktopPath = claudeDesktopConfigPath(home)
  const desktopJson = readJson(desktopPath)
  const desktopEntry = desktopJson?.mcpServers?.[SERVER_KEY] as McpServerEntry | undefined
  if (desktopEntry) {
    messages.push(`skipped ${desktopPath}; standalone Claude Desktop HTTP connectors are managed outside claude_desktop_config.json`)
  }

  const codexPath = codexConfigPath(home)
  if (existsSync(codexPath)) {
    const codexEntry = readCodexPersistentMemoryEntry(readFileSync(codexPath, 'utf8'))
    if (codexEntry) {
      registerCodexWrite(codexPath, buildEntryFromExisting(codexEntry, codexEntry.env?.PM_MCP_CLIENT_NAME ?? 'codex', derived))
      registrationWrites++
      addGlobalRuleTarget(ruleTargets, 'codex', home)
      messages.push(`refreshed ${codexPath}`)
    }
  }

  const projectCandidates = new Set<string>([root, ...claudeProjectPaths])
  for (const projectPath of projectCandidates) {
    const projectCodexPath = codexProjectConfigPath(projectPath)
    if (!existsSync(projectCodexPath)) continue
    const codexEntry = readCodexPersistentMemoryEntry(readFileSync(projectCodexPath, 'utf8'))
    if (!codexEntry) continue
    registerCodexWrite(projectCodexPath, buildEntryFromExisting(codexEntry, codexEntry.env?.PM_MCP_CLIENT_NAME ?? 'codex', derived))
    registrationWrites++
    addProjectRuleTarget(ruleTargets, 'codex', projectPath)
    messages.push(`refreshed ${projectCodexPath}`)
  }

  discoverPromptOnlyTargets(home, root, ruleTargets)

  const targets = [...ruleTargets.values()]
  if (targets.length > 0) {
    writeRuleTargets(targets, readDefaultRule())
    for (const target of targets) messages.push(`refreshed ${target.ruleFile} (+ ${target.memoryFile})`)
  }

  return { registrationWrites, ruleWrites: targets.length, messages }
}

function isMainModule(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false
}

if (isMainModule()) {
  const root = process.env.PM_ROOT ?? process.cwd()
  const result = refreshAgentInstall({ root, home: homedir() })
  if (result.registrationWrites === 0 && result.ruleWrites === 0) {
    console.log('[agent-update] no existing persistent-memory Claude/Codex agent artifacts detected; skipped')
  } else {
    console.log(`[agent-update] refreshed ${result.registrationWrites} MCP registration(s) and ${result.ruleWrites} prompt/rule target(s)`)
    for (const message of result.messages) console.log(`[agent-update] ${message}`)
  }
}
