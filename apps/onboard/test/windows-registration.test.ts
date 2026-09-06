import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentProfiles } from '../server/agent-profiles.ts'
import { buildMcpEntry, planRegistration, registerClaudeWrite, registerCodexWrite } from '../server/register.ts'
import { readPersistentMemoryTomlEntry } from '../server/mcp-toml.ts'
import { defaultMemoryBlock, targetMemoryFiles, writeRuleTargets } from '../server/rule.ts'

const apps = { claudeCli: true, claudeDesktop: true, codexCli: true, codexDesktop: true }
const entry = buildMcpEntry({
  mcpRuntime: 'node', apiUrl: 'http://127.0.0.1:8090', ollamaUrl: 'http://localhost:11434',
  streamUrl: 'http://127.0.0.1:8091/mcp', token: 'placeholder-token-must-not-be-registered',
  wrapperPath: 'C:\\Unused wrapper\\legacy.cmd',
})

function fixture(run: (root: string, owned: (path: string) => string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'pm-windows-registration-'))
  const owned = (path: string): string => {
    const child = relative(root, resolve(path))
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Test path escaped its disposable fixture.')
    return path
  }
  try { run(root, owned) } finally {
    // Validate the absolute, immediate temp child before recursive cleanup.
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('pm-windows-registration-') || lstatSync(root).isSymbolicLink()) {
      throw new Error('Refusing to clean an unowned registration fixture.')
    }
    rmSync(root, { recursive: true, force: true })
  }
}

function seed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('Windows agent profile registration', () => {
  it('resolves default and relocated native Windows profiles without ambient user settings', () => {
    const home = 'C:\\Users\\Zoë Example'
    expect(agentProfiles(home, { platform: 'win32', env: {}, exists: () => false })).toMatchObject({
      claudeJson: home + '\\.claude.json', claudeDir: home + '\\.claude',
      codexConfig: home + '\\.codex\\config.toml',
    })
    expect(agentProfiles(home, { platform: 'win32', exists: () => false, env: {
      CLAUDE_CONFIG_DIR: 'C:/Agent Profiles/Claude équipe', CODEX_HOME: 'C:/Agent Profiles/Codex 私',
    } })).toMatchObject({
      claudeJson: 'C:\\Agent Profiles\\Claude équipe\\.claude.json',
      codexConfig: 'C:\\Agent Profiles\\Codex 私\\config.toml',
    })
  })

  it('updates an existing legacy Claude profile instead of creating a competing JSON file', () => {
    fixture((root, owned) => {
      const home = owned(join(root, 'Profile Zoë Example'))
      const profileEnv = { CLAUDE_CONFIG_DIR: owned(join(root, 'Claude équipe')) }
      const legacy = owned(join(profileEnv.CLAUDE_CONFIG_DIR, '.config.json'))
      const newer = owned(join(profileEnv.CLAUDE_CONFIG_DIR, '.claude.json'))
      seed(legacy, '\uFEFF{"privateSetting":"placeholder-legacy-secret","mcpServers":{"other":{"command":"other.exe"}}}')
      seed(newer, '{"otherProfile":"do not change"}')
      const plan = planRegistration({ apps: { ...apps, codexCli: false, codexDesktop: false }, level: 'global', projectPaths: [], home, profileEnv })
      expect(plan.writes).toHaveLength(1)
      expect(plan.writes[0]!.path).toBe(legacy)
      registerClaudeWrite({ ...plan.writes[0]!, entry })
      expect(JSON.parse(readFileSync(legacy, 'utf8'))).toEqual({
        privateSetting: 'placeholder-legacy-secret', mcpServers: { other: { command: 'other.exe' }, 'persistent-memory': entry },
      })
      expect(readFileSync(newer, 'utf8')).toBe('{"otherProfile":"do not change"}')
    })
  })

  it('requires an absolute folder for Project scope while ignoring inactive folder text in Global scope', () => {
    fixture((root, owned) => {
      const home = owned(join(root, 'Profile One'))
      expect(() => planRegistration({ apps, level: 'project', projectPaths: [], home, profileEnv: {} })).toThrow('at least one absolute folder')
      expect(() => planRegistration({ apps, level: 'project', projectPaths: ['relative-path'], home, profileEnv: {} })).toThrow('absolute folder path')
      const global = planRegistration({ apps, level: 'global', projectPaths: ['relative-path'], home, profileEnv: {} })
      expect(global.writes).toHaveLength(2)
      for (const write of global.writes) owned(write.path)
      expect(existsSync(home)).toBe(false)
    })
  })

  it.each([false, true])('writes global MCP and guidance only to disposable profiles (custom=%s)', custom => {
    fixture((root, owned) => {
      const home = owned(join(root, 'Profile Zoë Example'))
      const profileEnv = custom ? {
        CLAUDE_CONFIG_DIR: owned(join(root, 'Agent Profiles', 'Claude équipe')),
        CODEX_HOME: owned(join(root, 'Agent Profiles', 'Codex 私')),
      } : {}
      const profiles = agentProfiles(home, { env: profileEnv })
      const claudeConfig = owned(profiles.claudeJson)
      const codexConfig = owned(profiles.codexConfig)
      const initialClaude = {
        privateSetting: 'placeholder-unrelated-secret',
        mcpServers: { other: { command: 'other.exe', env: { API_KEY: 'placeholder-other-key' } }, 'persistent-memory': { command: 'old-launcher' } },
        projects: { existing: { trusted: true } },
      }
      seed(claudeConfig, '\uFEFF' + JSON.stringify(initialClaude))
      const before = '\uFEFF# Préférences privées\r\nmodel = "keep-model"\r\n'
      const after = '[mcp_servers.other]\r\ncommand = \'C:\\Tools\\other.exe\'\r\n[mcp_servers.other.env]\r\nAPI_KEY = "placeholder-other-key"\r\n'
      seed(codexConfig, before + '[mcp_servers."persistent-memory"] # memory entry\r\ncommand = "old-launcher"\r\n' + after)
      if (custom) {
        seed(owned(join(home, '.claude.json')), '{"defaultProfile":"preserve"}')
        seed(owned(join(home, '.codex', 'config.toml')), '# Default profile stays unchanged\n')
      }
      const plan = planRegistration({ apps, level: 'global', projectPaths: [], home, profileEnv })
      expect(plan.writes.map(write => write.path)).toEqual([claudeConfig, codexConfig])
      const targets = targetMemoryFiles({ claude: true, codex: true, level: 'global', projectPaths: [], home, profileEnv })
      expect(targets.map(target => target.memoryFile)).toEqual([join(profiles.claudeDir, 'CLAUDE.md'), join(profiles.codexDir, 'AGENTS.md')])
      for (const target of targets) {
        owned(target.ruleFile)
        seed(owned(target.memoryFile), '# My instructions\n\nKeep this unrelated guidance.\n')
      }
      const apply = () => {
        for (const write of plan.writes) {
          owned(write.path)
          if (write.kind === 'claude') registerClaudeWrite({ ...write, entry })
          else registerCodexWrite(write.path, entry)
        }
        writeRuleTargets(targets, '# Fixture memory rule\nRead context before work.', defaultMemoryBlock('@rules/persistent-memory.md'))
      }
      apply()
      const claude = JSON.parse(readFileSync(claudeConfig, 'utf8'))
      expect(claude).toEqual({ ...initialClaude, mcpServers: { ...initialClaude.mcpServers, 'persistent-memory': { type: 'http', url: 'http://127.0.0.1:8091/mcp' } } })
      const codex = readFileSync(codexConfig, 'utf8')
      expect(codex.startsWith(before)).toBe(true)
      expect(codex.endsWith(after)).toBe(true)
      expect(readPersistentMemoryTomlEntry(codex)).toEqual({ url: 'http://127.0.0.1:8091/mcp', env: {} })
      expect(codex).not.toContain('old-launcher')
      expect(codex + JSON.stringify(claude)).not.toContain('placeholder-token-must-not-be-registered')
      for (const target of targets) {
        const memory = readFileSync(target.memoryFile, 'utf8')
        expect(memory).toContain('Keep this unrelated guidance.')
        expect(memory).toContain('@rules/persistent-memory.md')
        expect(readFileSync(target.ruleFile, 'utf8')).toBe('# Fixture memory rule\nRead context before work.\n')
      }
      const paths = [claudeConfig, codexConfig, ...targets.flatMap(target => [target.memoryFile, target.ruleFile])]
      const snapshots = paths.map(path => readFileSync(path, 'utf8'))
      apply()
      expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(snapshots)
      expect(existsSync(owned(profiles.claudeDesktopConfig))).toBe(false)
      if (custom) {
        expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{"defaultProfile":"preserve"}')
        expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('# Default profile stays unchanged\n')
      }
    })
  })

  it('writes project MCP and per-project guidance without replacing global or sibling settings', () => {
    fixture((root, owned) => {
      const home = owned(join(root, 'Profile Zoë Example'))
      const project = owned(join(root, 'Projects', 'Mémoires équipe'))
      const sibling = owned(join(root, 'Projects', 'Other workspace'))
      const profileEnv = { CLAUDE_CONFIG_DIR: owned(join(root, 'Claude settings')), CODEX_HOME: owned(join(root, 'Codex settings')) }
      const profiles = agentProfiles(home, { env: profileEnv })
      const existingKey = process.platform === 'win32' ? project.replaceAll('\\', '/').toUpperCase() : project
      const original = {
        mcpServers: { global: { url: 'https://global.example.test/mcp' } },
        projects: {
          [existingKey]: { trustAccepted: true, privateSetting: 'placeholder-existing-secret', mcpServers: { other: { command: 'other.exe' } } },
          [sibling]: { trustAccepted: true, mcpServers: { sibling: { url: 'https://sibling.example.test/mcp' } } },
        },
      }
      seed(owned(profiles.claudeJson), JSON.stringify(original))
      seed(owned(profiles.codexConfig), '# Global Codex remains untouched\n')
      const codexProject = owned(join(project, '.codex', 'config.toml'))
      const foreign = '[mcp_servers.other]\nurl = "https://other.example.test/mcp"\n'
      seed(codexProject, foreign)
      const projectPaths = process.platform === 'win32' ? [project, project.replaceAll('\\', '/').toUpperCase()] : [project, project]
      const plan = planRegistration({ apps, level: 'project', projectPaths, home, profileEnv })
      expect(plan.writes.map(write => write.path)).toEqual([profiles.claudeJson, codexProject])
      const targets = targetMemoryFiles({ claude: true, codex: true, level: 'project', projectPaths, home, profileEnv })
      expect(targets.map(target => [target.memoryFile, target.ruleRef])).toEqual([
        [join(project, 'CLAUDE.md'), '@.claude/rules/persistent-memory.md'],
        [join(project, 'AGENTS.md'), '@.codex/rules/persistent-memory.md'],
      ])
      for (const target of targets) {
        owned(target.ruleFile)
        seed(owned(target.memoryFile), '# Project instructions\n\nKeep this project guidance.\n')
      }
      const apply = () => {
        for (const write of plan.writes) {
          owned(write.path)
          if (write.kind === 'claude') registerClaudeWrite({ ...write, entry })
          else registerCodexWrite(write.path, entry)
        }
        writeRuleTargets(targets, '# Project memory rule', defaultMemoryBlock('@rules/persistent-memory.md'))
      }
      apply()
      const actual = JSON.parse(readFileSync(profiles.claudeJson, 'utf8'))
      expect(actual.mcpServers).toEqual(original.mcpServers)
      expect(Object.keys(actual.projects)).toEqual([existingKey, sibling])
      expect(actual.projects[sibling]).toEqual(original.projects[sibling])
      expect(actual.projects[existingKey]).toEqual({ ...original.projects[existingKey], mcpServers: { other: { command: 'other.exe' }, 'persistent-memory': entry } })
      expect(readFileSync(codexProject, 'utf8').startsWith(foreign)).toBe(true)
      expect(readPersistentMemoryTomlEntry(readFileSync(codexProject, 'utf8'))).toEqual({ url: 'http://127.0.0.1:8091/mcp', env: {} })
      expect(readFileSync(profiles.codexConfig, 'utf8')).toBe('# Global Codex remains untouched\n')
      for (const target of targets) {
        const text = readFileSync(target.memoryFile, 'utf8')
        expect(text).toContain('Keep this project guidance.')
        expect(text).toContain(target.ruleRef)
      }
      const paths = [profiles.claudeJson, codexProject, ...targets.flatMap(target => [target.memoryFile, target.ruleFile])]
      const snapshots = paths.map(path => readFileSync(path, 'utf8'))
      apply()
      expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(snapshots)
      expect(existsSync(join(sibling, '.codex', 'config.toml'))).toBe(false)
    })
  })

  it.each([
    { body: '{"private":"placeholder-secret-fragment",', level: 'global' },
    { body: '[]', level: 'global' }, { body: 'null', level: 'global' },
    { body: '"placeholder-secret-fragment"', level: 'global' },
    { body: '{"mcpServers":[]}', level: 'global' },
    { body: '{"mcpServers":null}', level: 'global' },
    { body: '{"projects":[]}', level: 'project' },
    { body: '{"projects":null}', level: 'project' },
  ] as const)('leaves invalid Claude configuration byte-identical: $body', ({ body, level }) => {
    fixture((root, owned) => {
      const path = owned(join(root, 'Profile équipe', '.claude.json'))
      seed(path, body)
      const before = readFileSync(path)
      let message = ''
      try { registerClaudeWrite({ path, entry, level, projectPaths: [owned(join(root, 'Project One'))] }) } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain('existing configuration was not changed')
      expect(message).not.toContain('placeholder-secret-fragment')
      expect(readFileSync(path)).toEqual(before)
    })
  })

  it.each([null, { mcpServers: null }, { mcpServers: [] }])('preserves an invalid project entry before registration: %j', projectEntry => {
    fixture((root, owned) => {
      const path = owned(join(root, 'Profile équipe', '.claude.json'))
      const project = owned(join(root, 'Project One'))
      seed(path, JSON.stringify({ privateSetting: 'placeholder-secret-fragment', projects: { [project]: projectEntry } }))
      const before = readFileSync(path)
      expect(() => registerClaudeWrite({ path, entry, level: 'project', projectPaths: [project] })).toThrow('existing configuration was not changed')
      expect(readFileSync(path)).toEqual(before)
    })
  })
})
