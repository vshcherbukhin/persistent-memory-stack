import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { refreshAgentInstall } from '../server/agent-update'
import { agentProfileEnvironment, agentProfiles, normalizedProjectPaths } from '../server/agent-profiles'
import { hostCommand, hostEnvironment } from '../server/host'
import { planRegistration } from '../server/register'
import { targetMemoryFiles, writeRuleTargets } from '../server/rule'

const fixtures: string[] = []
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'pm-agent-refresh-'))
  fixtures.push(base)
  const home = join(base, 'Windows User Équipe')
  const root = join(base, 'Project 空间 with spaces')
  const profileEnv = { CLAUDE_CONFIG_DIR: join(home, 'Claude work 配置'), CODEX_HOME: join(home, 'Codex work 配置'), APPDATA: join(home, 'Roaming') }
  mkdirSync(root, { recursive: true })
  return { base, home, root, profileEnv, profiles: agentProfiles(home, { env: profileEnv }) }
}
function write(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
afterEach(() => {
  for (const base of fixtures.splice(0)) {
    const owned = relative(resolve(tmpdir()), resolve(base))
    expect(owned && !owned.startsWith('..') && !isAbsolute(owned)).toBeTruthy()
    rmSync(base, { recursive: true, force: true })
  }
})

describe('Windows agent refresh and host profile wiring', () => {
  it('honors an existing legacy Claude profile file without changing a newer valid copy', () => {
    const f = fixture()
    const legacy = join(f.profiles.claudeDir, '.config.json')
    const untouched = '{"oauthAccount":{"marker":"newer-copy-must-stay"}}'
    write(f.profiles.claudeJson, untouched)
    write(legacy, '\uFEFF' + JSON.stringify({ preference: 'legacy-active', mcpServers: { 'persistent-memory': { command: 'old-wrapper' } } }))
    expect(agentProfiles(f.home, { env: f.profileEnv }).claudeJson).toBe(legacy)
    const result = refreshAgentInstall({ root: f.root, home: f.home, profileEnv: f.profileEnv, env: {} })
    expect(result.registrationWrites).toBe(1)
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toMatchObject({ preference: 'legacy-active', mcpServers: { 'persistent-memory': { type: 'http', url: 'http://127.0.0.1:8091/mcp' } } })
    expect(readFileSync(f.profiles.claudeJson, 'utf8')).toBe(untouched)
  })

  it('supports injected legacy-file detection without reading a host profile', () => {
    const paths: string[] = []
    const profiles = agentProfiles('C:\\Users\\Fixture', { platform: 'win32', env: { CLAUDE_CONFIG_DIR: 'D:\\Profiles\\Claude' }, exists: path => { paths.push(path); return true } })
    expect(profiles.claudeJson).toBe('D:\\Profiles\\Claude\\.config.json')
    expect(paths).toEqual(['D:\\Profiles\\Claude\\.config.json'])
  })

  it('refreshes only the selected custom profiles and keeps other copies intact', () => {
    const f = fixture()
    const claude = { oauthAccount: { marker: 'fixture-private-value' }, mcpServers: { neighbour: { command: 'keep.exe', env: { PRIVATE: 'fixture-secret' } }, 'persistent-memory': { command: 'old-mac-wrapper.sh' } } }
    write(f.profiles.claudeJson, '\uFEFF' + JSON.stringify(claude))
    const neighbour = '[mcp_servers.neighbour]\r\ncommand = "keep.exe"\r\n[mcp_servers.neighbour.env]\r\nPRIVATE = "fixture-secret"\r\n'
    write(f.profiles.codexConfig, '# équipe\r\n[mcp_servers.\'persistent-memory\'] # owned\r\ncommand = "old-mac-wrapper.sh"\r\n' + neighbour)
    const oldDefaultClaude = join(f.home, '.claude.json')
    const oldDefaultCodex = join(f.home, '.codex', 'config.toml')
    write(oldDefaultClaude, '{"defaultProfile":"untouched"}')
    write(oldDefaultCodex, '# untouched default profile\n')
    write(join(f.profiles.codexDir, 'AGENTS.md'), '# Existing Codex guidance\r\n\r\n## Team policy\r\nKeep this instruction.\r\n')
    const result = refreshAgentInstall({ root: f.root, home: f.home, profileEnv: f.profileEnv, env: { PM_MCP_STREAM_URL: 'http://127.0.0.1:8091/mcp' } })
    expect(result.registrationWrites).toBe(2)
    expect(result.ruleWrites).toBe(2)
    const actualClaude = JSON.parse(readFileSync(f.profiles.claudeJson, 'utf8'))
    expect(actualClaude.oauthAccount).toEqual(claude.oauthAccount)
    expect(actualClaude.mcpServers.neighbour).toEqual(claude.mcpServers.neighbour)
    expect(actualClaude.mcpServers['persistent-memory']).toEqual({ type: 'http', url: 'http://127.0.0.1:8091/mcp' })
    expect(readFileSync(f.profiles.codexConfig, 'utf8')).toContain(neighbour)
    expect(readFileSync(f.profiles.codexConfig, 'utf8')).not.toContain('old-mac-wrapper.sh')
    expect(readFileSync(oldDefaultClaude, 'utf8')).toBe('{"defaultProfile":"untouched"}')
    expect(readFileSync(oldDefaultCodex, 'utf8')).toBe('# untouched default profile\n')
    const guidance = readFileSync(join(f.profiles.codexDir, 'AGENTS.md'), 'utf8')
    expect(guidance).toContain('read @rules/persistent-memory.md before using memory tools')
    expect(guidance).toContain('Keep this instruction.')
    expect(guidance).not.toContain('auto-loaded')
    expect(existsSync(join(f.profiles.claudeDir, 'rules', 'persistent-memory.md'))).toBe(true)
    expect(existsSync(join(f.profiles.codexDir, 'rules', 'persistent-memory.md'))).toBe(true)
    expect(existsSync(join(f.root, '.env.persistent-memory'))).toBe(false)
  })

  it('refreshes registered project MCP and portable rule references under a custom profile', () => {
    const f = fixture()
    write(f.profiles.claudeJson, JSON.stringify({ projects: { [f.root]: { hasTrustDialogAccepted: true, mcpServers: { 'persistent-memory': { url: 'http://127.0.0.1:8091/mcp' }, other: { command: 'keep' } } } } }))
    write(join(f.root, '.codex', 'config.toml'), '[mcp_servers.persistent-memory]\nurl = "http://127.0.0.1:8091/mcp"\n')
    const result = refreshAgentInstall({ root: f.root, home: f.home, profileEnv: f.profileEnv, env: {} })
    expect(result.registrationWrites).toBe(2)
    expect(result.ruleWrites).toBe(2)
    const project = JSON.parse(readFileSync(f.profiles.claudeJson, 'utf8')).projects[f.root]
    expect(project.hasTrustDialogAccepted).toBe(true)
    expect(project.mcpServers.other).toEqual({ command: 'keep' })
    expect(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8')).toContain('@.claude/rules/persistent-memory.md')
    expect(readFileSync(join(f.root, 'AGENTS.md'), 'utf8')).toContain('read @.codex/rules/persistent-memory.md')
    expect(existsSync(join(f.profiles.codexDir, 'config.toml'))).toBe(false)
  })

  it('does not create registration or rules when the explicit profiles contain no artifacts', () => {
    const f = fixture()
    const result = refreshAgentInstall({ root: f.root, home: f.home, profileEnv: f.profileEnv, env: {} })
    expect(result.registrationWrites).toBe(0)
    expect(result.ruleWrites).toBe(0)
    expect(existsSync(f.profiles.claudeDir)).toBe(false)
    expect(existsSync(f.profiles.codexDir)).toBe(false)
  })

  it('leaves malformed custom JSON byte-identical and reports the skipped file without its contents', () => {
    const f = fixture()
    const malformed = '{"private":"fixture-private-value", broken'
    write(f.profiles.claudeJson, malformed)
    const result = refreshAgentInstall({ root: f.root, home: f.home, profileEnv: f.profileEnv, env: {} })
    expect(readFileSync(f.profiles.claudeJson, 'utf8')).toBe(malformed)
    expect(result.registrationWrites).toBe(0)
    expect(result.messages.join('\n')).toContain('existing configuration was not changed')
    expect(result.messages.join('\n')).not.toContain('fixture-private-value')
  })

  it('keeps ordinary macOS profile defaults and relocates only explicit overrides', () => {
    expect(agentProfiles('/Users/équipe', { platform: 'darwin' })).toMatchObject({ claudeDir: '/Users/équipe/.claude', claudeJson: '/Users/équipe/.claude.json', codexConfig: '/Users/équipe/.codex/config.toml', claudeDesktopConfig: '/Users/équipe/Library/Application Support/Claude/claude_desktop_config.json' })
    expect(agentProfiles('/Users/équipe', { platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/Profiles/Claude work', CODEX_HOME: '/Profiles/Codex work' } })).toMatchObject({ claudeDir: '/Profiles/Claude work', claudeJson: '/Profiles/Claude work/.claude.json', codexConfig: '/Profiles/Codex work/config.toml' })
  })

  it('carries only profile directory metadata and normalizes native Windows paths without changing argv', () => {
    const env = { CODEX_HOME: '/c/Users/Équipe/Codex Profile', CLAUDE_CONFIG_DIR: '/c/Users/Équipe/Claude Profile', APPDATA: 'C:\\Users\\Équipe\\Roaming', ANTHROPIC_API_KEY: 'fixture-secret' }
    expect(agentProfileEnvironment(env)).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(hostEnvironment({ platform: 'win32', env }).CODEX_HOME).toBe('c:\\Users\\Équipe\\Codex Profile')
    expect(agentProfiles('C:\\Users\\Équipe', { platform: 'win32', env }).claudeJson).toBe('c:\\Users\\Équipe\\Claude Profile\\.claude.json')
    const args = ['run', 'sample', '--', 'C:\\Project 空间\\with spaces']
    const command = hostCommand('npm', args, { platform: 'win32', env, execPath: 'C:\\Program Files\\nodejs\\node.exe', exists: path => path.endsWith('npm-cli.js') })
    expect(command.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(command.args.slice(1)).toEqual(args)
    expect(command.args[0]).toContain('npm-cli.js')
  })

  it('trims and deduplicates Windows project paths and rejects relative destinations', () => {
    expect(normalizedProjectPaths([' C:\\Work Space\\项目 ', 'c:/Work Space/项目', '/c/Work Space/项目'], 'win32')).toEqual(['C:\\Work Space\\项目'])
    for (const value of ['relative-folder', 'C:relative-folder']) expect(() => normalizedProjectPaths([value], 'win32')).toThrow('absolute folder path')
    expect(() => normalizedProjectPaths(['relative-folder'], 'darwin')).toThrow('absolute folder path')
  })

  it('does not use inactive project text for global scope or silently broaden an empty project scope', () => {
    const f = fixture()
    const input = { apps: { claudeCli: true, claudeDesktop: false, codexCli: true, codexDesktop: false }, home: f.home, profileEnv: f.profileEnv, projectPaths: ['incomplete-relative-text'] }
    expect(planRegistration({ ...input, level: 'global' }).writes.every(write => write.level === 'global')).toBe(true)
    expect(() => planRegistration({ ...input, level: 'project', projectPaths: ['  '] })).toThrow('requires at least one absolute folder path')
    expect(() => targetMemoryFiles({ claude: true, codex: true, home: f.home, level: 'project', projectPaths: [] })).toThrow('requires at least one absolute folder path')
  })

  it('writes Codex protocol to the active nonempty override file and preserves the shadowed file', () => {
    const f = fixture()
    const defaultFile = join(f.profiles.codexDir, 'AGENTS.md')
    const override = join(f.profiles.codexDir, 'AGENTS.override.md')
    write(defaultFile, '# Shadowed guidance\nKeep this file unchanged.\n')
    write(override, '# Active guidance\n\n## Team policy\nKeep this active policy.\n')
    const targets = targetMemoryFiles({ claude: false, codex: true, home: f.home, profileEnv: f.profileEnv, level: 'global', projectPaths: [] })
    expect(targets[0]!.memoryFile).toBe(override)
    writeRuleTargets(targets, '# Fixture detailed protocol', '## Persistent Memory Usage (MANDATORY)\n\n- Detailed protocol: @rules/persistent-memory.md (auto-loaded when this file is read).')
    expect(readFileSync(override, 'utf8')).toContain('(read this file before using memory tools)')
    expect(readFileSync(override, 'utf8')).toContain('Keep this active policy.')
    expect(readFileSync(defaultFile, 'utf8')).toBe('# Shadowed guidance\nKeep this file unchanged.\n')
  })
})
