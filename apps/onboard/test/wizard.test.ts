/**
 * Unit matrix for the flow-routed wizard's pure logic: system/app detection,
 * MCP-registration builders + idempotent config merges, and the memory-rule
 * writer. No filesystem, no network — pure functions only.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { recommendModel, detectApps, bytesToGB } from '../server/detect.ts'
import { terminalLineTone } from '../web/src/components.tsx'
import {
  buildMcpEntry,
  mergeClaudeJsonGlobal,
  mergeClaudeJsonProject,
  buildCodexBlock,
  mergeCodexToml,
} from '../server/register.ts'

describe('recommendModel (by RAM tier)', () => {
  it('≥64→8b, ≥16→4b (default), else 0.6b', () => {
    expect(recommendModel({ totalMemGB: 96 })).toEqual({ model: 'qwen3-embedding:8b', dim: 4096 })
    expect(recommendModel({ totalMemGB: 64 })).toEqual({ model: 'qwen3-embedding:8b', dim: 4096 })
    expect(recommendModel({ totalMemGB: 38.7 })).toEqual({ model: 'qwen3-embedding:4b', dim: 2560 })
    expect(recommendModel({ totalMemGB: 16 })).toEqual({ model: 'qwen3-embedding:4b', dim: 2560 })
    expect(recommendModel({ totalMemGB: 8 })).toEqual({ model: 'qwen3-embedding:0.6b', dim: 1024 })
  })
  it('tier boundaries', () => {
    expect(recommendModel({ totalMemGB: 15.9 }).model).toBe('qwen3-embedding:0.6b')
    expect(recommendModel({ totalMemGB: 63.9 }).model).toBe('qwen3-embedding:4b')
  })
})

describe('bytesToGB', () => {
  it('converts + rounds to 1 decimal', () => {
    expect(bytesToGB(38_654_705_664)).toBeCloseTo(38.7, 1)
    expect(bytesToGB(0)).toBe(0)
  })
})

describe('terminal log severity colors', () => {
  it('classifies errors red, warnings yellow, and ordinary info green', () => {
    expect(terminalLineTone('Step "Install Docker" failed.')).toBe('error')
    expect(terminalLineTone('npm ERR! code 1')).toBe('error')
    expect(terminalLineTone('fatal: could not read from remote repository')).toBe('error')
    expect(terminalLineTone('FAIL: 2')).toBe('error')
    expect(terminalLineTone('FAIL  Port 8091 (MCP-Stream) NOT reachable')).toBe('error')
    expect(terminalLineTone("FAIL  Container persistent-memory-mcp is 'restarting' (expected running)")).toBe('error')
    expect(terminalLineTone('WARN deprecated package')).toBe('warn')
    expect(terminalLineTone('WARNING: deprecated option used')).toBe('warn')
    expect(terminalLineTone('[seed] local dashboard user is ready')).toBe('info')
  })
})

describe('detectApps (probe booleans → app presence)', () => {
  const P = (over: Record<string, boolean> = {}) => ({
    claudeJson: false, claudeDesktopCfg: false, claudeApp: false,
    codexToml: false, codexApp: false, ...over,
  })
  it('all present', () => {
    expect(detectApps(P({ claudeJson: true, claudeDesktopCfg: true, claudeApp: true, codexToml: true, codexApp: true })))
      .toEqual({ claudeCli: true, claudeDesktop: true, codexCli: true, codexDesktop: true })
  })
  it('none present', () => {
    expect(Object.values(detectApps(P())).every((v) => v === false)).toBe(true)
  })
  it('claudeDesktop is true if EITHER the config OR the .app is present', () => {
    expect(detectApps(P({ claudeDesktopCfg: true })).claudeDesktop).toBe(true)
    expect(detectApps(P({ claudeApp: true })).claudeDesktop).toBe(true)
  })
  it('codexCli (config.toml) and codexDesktop (.app) are independent', () => {
    expect(detectApps(P({ codexToml: true })).codexCli).toBe(true)
    expect(detectApps(P({ codexToml: true })).codexDesktop).toBe(false)
    expect(detectApps(P({ codexApp: true })).codexDesktop).toBe(true)
  })
})

const DOCKER = {
  mcpRuntime: 'stream' as const,
  apiUrl: 'http://host.docker.internal:8090',
  ollamaUrl: 'http://host.docker.internal:11434',
  token: 'tid.secret',
  wrapperPath: '/repo/apps/mcp/persistent-memory-mcp.sh',
  streamUrl: 'http://127.0.0.1:8091/mcp',
  clientName: 'codex',
}
const LEGACY_NODE = { ...DOCKER, mcpRuntime: 'node' as const, apiUrl: 'http://localhost:8090', ollamaUrl: 'http://localhost:11434' }

describe('buildMcpEntry', () => {
  it('stream form: remote HTTP MCP URL, no command/env process launcher', () => {
    const e = buildMcpEntry(DOCKER)
    expect(e.type).toBe('http')
    expect(e.url).toBe('http://127.0.0.1:8091/mcp')
    expect(e).not.toHaveProperty('alwaysLoad')
    expect(e.command).toBeUndefined()
    expect(e.env ?? {}).toEqual({})
  })
  it('legacy node input is treated as a stream registration alias', () => {
    const e = buildMcpEntry({
      ...LEGACY_NODE,
      memoryInstallMode: 'personal-and-shared',
      defaultMemorySurface: 'personal',
      personalApiUrl: 'http://localhost:8090',
      sharedApiUrl: 'https://memory.example.test',
      sharedUserToken: 'tid.secret',
    })

    expect(e).toEqual({ type: 'http', url: 'http://127.0.0.1:8091/mcp' })
  })
})

describe('mergeClaudeJsonGlobal', () => {
  const entry = buildMcpEntry(DOCKER)
  it('sets top-level mcpServers["persistent-memory"] on empty json', () => {
    expect(mergeClaudeJsonGlobal({}, entry)).toEqual({ mcpServers: { 'persistent-memory': entry } })
  })
  it('preserves a sibling server (mem0) + other top-level keys', () => {
    const before = { numStartups: 5, mcpServers: { mem0: { command: 'x' } } }
    const after = mergeClaudeJsonGlobal(before, entry)
    expect(after.numStartups).toBe(5)
    expect(after.mcpServers.mem0).toEqual({ command: 'x' })
    expect(after.mcpServers['persistent-memory']).toEqual(entry)
  })
  it('is idempotent', () => {
    const once = mergeClaudeJsonGlobal({ mcpServers: { mem0: { command: 'x' } } }, entry)
    expect(mergeClaudeJsonGlobal(once, entry)).toEqual(once)
  })
})

describe('mergeClaudeJsonProject', () => {
  const entry = buildMcpEntry(DOCKER)
  it('creates projects[path].mcpServers, preserves other projects + servers', () => {
    const before = { projects: { '/other': { mcpServers: { mem0: { command: 'x' } }, allowedTools: [] } } }
    const after = mergeClaudeJsonProject(before, '/repo', entry)
    expect(after.projects['/other'].mcpServers.mem0).toEqual({ command: 'x' })
    expect(after.projects['/repo'].mcpServers['persistent-memory']).toEqual(entry)
  })
  it('preserves sibling servers under the SAME project', () => {
    const before = { projects: { '/repo': { mcpServers: { mem0: { command: 'x' } } } } }
    const after = mergeClaudeJsonProject(before, '/repo', entry)
    expect(after.projects['/repo'].mcpServers.mem0).toEqual({ command: 'x' })
    expect(after.projects['/repo'].mcpServers['persistent-memory']).toEqual(entry)
  })
  it('is idempotent', () => {
    const once = mergeClaudeJsonProject({}, '/repo', entry)
    expect(mergeClaudeJsonProject(once, '/repo', entry)).toEqual(once)
  })
})

describe('buildCodexBlock + mergeCodexToml', () => {
  const block = buildCodexBlock(buildMcpEntry(DOCKER))
  it('emits a valid-looking [mcp_servers.persistent-memory] table + .env subtable', () => {
    expect(block).toContain('[mcp_servers.persistent-memory]')
    expect(block).toContain('url = "http://127.0.0.1:8091/mcp"')
    expect(block).not.toContain('command =')
    expect(block).not.toContain('[mcp_servers.persistent-memory.env]')
    expect(block).not.toContain('alwaysLoad')
  })
  it('appends when absent, preserving a neighboring table', () => {
    const cur = '[mcp_servers.other]\ncommand = "y"\n'
    const out = mergeCodexToml(cur, block)
    expect(out).toContain('[mcp_servers.other]')
    expect(out).toContain('[mcp_servers.persistent-memory]')
  })
  it('replaces our table in place (no duplicate), preserving neighbors before AND after', () => {
    const cur = '[mcp_servers.other]\ncommand = "y"\n\n[mcp_servers.persistent-memory]\ncommand = "OLD"\n\n[mcp_servers.persistent-memory.env]\nAPI_URL = "old"\n\n[mcp_servers.zzz]\ncommand = "z"\n'
    const out = mergeCodexToml(cur, block)
    expect(out.match(/\[mcp_servers\.persistent-memory\]/g)!.length).toBe(1)
    expect(out).not.toContain('command = "OLD"')
    expect(out).toContain('[mcp_servers.other]')
    expect(out).toContain('[mcp_servers.zzz]')
    expect(out).toContain('command = "z"')
  })
  it('is idempotent', () => {
    const once = mergeCodexToml('[mcp_servers.other]\ncommand = "y"\n', block)
    expect(mergeCodexToml(once, block)).toBe(once)
  })
})

import { defaultMemoryBlock, injectMemoryBlock, targetMemoryFiles, readDefaultRule } from '../server/rule.ts'

describe('defaultMemoryBlock + injectMemoryBlock', () => {
  it('places the memory block as the first section after an existing document title', () => {
    const md = '# Global Claude Code Instructions\n\n## Git Safety\n\nKeep changes safe.\n'
    const out = injectMemoryBlock(md, defaultMemoryBlock('@rules/persistent-memory.md'))
    expect(out.startsWith('# Global Claude Code Instructions\n\n## Persistent Memory Usage (MANDATORY)')).toBe(true)
    expect(out).toContain('## Git Safety')
  })
  it('replaces old generated memory snippets instead of duplicating them', () => {
    const md = [
      '# Global Claude Code Instructions',
      '',
      '- @rules/persistent-memory.md — team-shared memory protocol (persistent-memory MCP): old line.',
      '',
      '## Persistent Memory Usage (MANDATORY)',
      '',
      '- old block',
      '',
      '## Git Safety',
      '',
      'Keep changes safe.',
      '',
    ].join('\n')
    const once = injectMemoryBlock(md, defaultMemoryBlock('@rules/persistent-memory.md'))
    const twice = injectMemoryBlock(once, defaultMemoryBlock('@rules/persistent-memory.md'))
    expect((once.match(/Persistent Memory Usage \(MANDATORY\)/g) ?? []).length).toBe(1)
    expect(once).not.toContain('old line')
    expect(once).not.toContain('old block')
    expect(twice).toBe(once)
  })
  it('removes the legacy Memory Save Triggers block before inserting the current block', () => {
    const md = [
      '# Global Claude Code Instructions',
      '',
      '## Memory Save Triggers (MANDATORY)',
      '',
      'When any of these happen, STOP and call `add_memory` IMMEDIATELY in the same response — not "later", not "at session end":',
      '',
      '- **User corrects you** — save what you tried, why it was wrong, the correction, the right approach. Highest-value learning.',
      '- **A tool doesn\'t cover something you expected** — save the tool, the gap, the workaround.',
      '',
      '## Git Safety',
      '',
      'Keep changes safe.',
      '',
    ].join('\n')
    const out = injectMemoryBlock(md, defaultMemoryBlock('@rules/persistent-memory.md'))
    expect((out.match(/Persistent Memory Usage \(MANDATORY\)/g) ?? []).length).toBe(1)
    expect(out).not.toContain('Memory Save Triggers')
    expect(out).not.toContain("not \"later\", not \"at session end\"")
    expect(out).toContain('## Git Safety')
  })
  it('removes the legacy Mem0 Issues block before inserting the current block', () => {
    const md = [
      '# Global Codex Instructions',
      '',
      '## Persistent Memory Usage (MANDATORY)',
      '',
      '- old block',
      '',
      '## Mem0 Issues (MANDATORY)',
      '',
      'If any mem0 tool call fails or returns suspect output, NOTIFY the user.',
      '',
      '- **401 `AuthenticationError`** — mem0 MCP cached token expired.',
      '',
      '## README Maintenance (MANDATORY)',
      '',
      'No later.',
      '',
    ].join('\n')
    const out = injectMemoryBlock(md, defaultMemoryBlock('@rules/persistent-memory.md'))
    expect((out.match(/Persistent Memory Usage \(MANDATORY\)/g) ?? []).length).toBe(1)
    expect(out).not.toContain('Mem0 Issues')
    expect(out).not.toContain('mem0 MCP cached token expired')
    expect(out).toContain('## README Maintenance (MANDATORY)')
  })
})

describe('targetMemoryFiles', () => {
  it('claude→CLAUDE.md, codex→AGENTS.md; global under home', () => {
    const t = targetMemoryFiles({ claude: true, codex: true, level: 'global', projectPaths: [], home: '/h' })
    expect(t.find((x) => x.kind === 'claude')).toMatchObject({
      memoryFile: '/h/.claude/CLAUDE.md',
      ruleFile: '/h/.claude/rules/persistent-memory.md',
      ruleRef: '@rules/persistent-memory.md',
    })
    expect(t.find((x) => x.kind === 'codex')).toMatchObject({
      memoryFile: '/h/.codex/AGENTS.md',
      ruleFile: '/h/.codex/rules/persistent-memory.md',
      ruleRef: '@rules/persistent-memory.md',
    })
  })
  it('project scope → one target per project path', () => {
    const t = targetMemoryFiles({ claude: true, codex: true, level: 'project', projectPaths: ['/a', '/b'], home: '/h' })
    expect(t.map((x) => x.memoryFile).sort()).toEqual(['/a/AGENTS.md', '/a/CLAUDE.md', '/b/AGENTS.md', '/b/CLAUDE.md'])
    expect(t.find((x) => x.kind === 'codex' && x.memoryFile === '/a/AGENTS.md')).toMatchObject({
      ruleFile: '/a/.codex/rules/persistent-memory.md',
      ruleRef: '@.codex/rules/persistent-memory.md',
    })
  })
  it('no ecosystems → empty', () => {
    expect(targetMemoryFiles({ claude: false, codex: false, level: 'global', projectPaths: [], home: '/h' })).toEqual([])
  })
})

describe('readDefaultRule (committed template)', () => {
  it('loads a non-trivial graph-first rule covering retrieval + add/update/delete', () => {
    const txt = readDefaultRule()
    expect(txt.length).toBeGreaterThan(300)
    expect(txt.split(/\r?\n/).length).toBeLessThanOrEqual(200)
    expect(txt).toMatch(/recall_context/)
    expect(txt).toMatch(/search_memories|add_memory/)
    expect(txt).toMatch(/update_memory/)
    expect(txt).toMatch(/delete_memory/)
    expect(txt).toMatch(/timeline|graph/i)
    expect(txt).toMatch(/ToolSearch|tool_search/)
  })
  it('instructs agents to persist project memory surface choice and default non-project work to personal/general', () => {
    const txt = readDefaultRule()

    expect(txt).toMatch(/Personal Memories/)
    expect(txt).toMatch(/Shared Memories/)
    expect(txt).toMatch(/project.*memory surface/i)
    expect(txt).toMatch(/non-project.*personal/i)
    expect(txt).toMatch(/general/i)
  })
  it('keeps the global rule template focused on unknowns without forcing heavyweight process', () => {
    const txt = readDefaultRule()

    expect(txt).toMatch(/## Work through unknowns/)
    expect(txt).toMatch(/blind-spot pass/)
    expect(txt).toMatch(/high-leverage questions/)
    expect(txt).toMatch(/\.local\/documents/)
    expect(txt).toMatch(/resolved unknowns/)
    expect(txt).not.toMatch(/Fable/)
    expect(txt).not.toMatch(/quiz/i)
  })
})

import { buildSteps } from '../server/steps.ts'

describe('buildSteps (flow-aware)', () => {
  const env = { DATABASE_MIGRATE_URL: 'postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory', PM_APP_PASSWORD: 'PW', EMBED_PROVIDER: 'ollama', EMBED_MODEL: 'qwen3-embedding:4b' }
  it('personal-first install = local stack with MCP stream profile + register + write-rule', () => {
    const steps = buildSteps({ flow: 'full', env })
    expect(steps.map((s) => s.id))
      .toEqual(['deps', 'pull-model', 'compose-up', 'wait-postgres', 'prisma-migrate', 'rls', 'seed', 'restart-app', 'wait-mcp', 'verify', 'register', 'write-rule'])
    expect(steps.find((s) => s.id === 'compose-up')?.envOverride?.COMPOSE_PROFILES).toBe('mcp-stream')
    expect(steps.find((s) => s.id === 'compose-up')?.envOverride?.COMPOSE_PARALLEL_LIMIT).toBe('1')
    expect(steps.find((s) => s.id === 'wait-mcp')?.kind).toBe('wait')
  })
  it('legacy node runtime input is ignored and never adds build-mcp-node', () => {
    expect(buildSteps({ flow: 'full', mcpRuntime: 'node', env }).map((s) => s.id))
      .toEqual(['deps', 'pull-model', 'compose-up', 'wait-postgres', 'prisma-migrate', 'rls', 'seed', 'restart-app', 'wait-mcp', 'verify', 'register', 'write-rule'])
  })
  it('legacy engine flow aliases to personal-first install and pulls the shared server pin after local verify', () => {
    const steps = buildSteps({
      flow: 'engine',
      env,
      pullModel: 'qwen3-embedding:4b',
      streamApiUrl: 'http://127.0.0.1:12090',
      streamToken: 'tid.secret',
      streamOllamaUrl: 'http://localhost:11434',
      memoryInstallMode: 'personal-and-shared',
    })
    expect(steps.map((s) => s.id)).toEqual([
      'deps',
      'pull-model',
      'compose-up',
      'wait-postgres',
      'prisma-migrate',
      'rls',
      'seed',
      'restart-app',
      'wait-mcp',
      'verify',
      'pull-shared-model',
      'shared-connect',
      'register',
      'write-rule',
    ])
    expect(steps.find((s) => s.id === 'pull-shared-model')!.cmd).toEqual(['ollama', 'pull', 'qwen3-embedding:4b'])
  })
  it('legacy mcp-only flow is a personal-first install alias, not a shared-only runtime', () => {
    const steps = buildSteps({
      flow: 'mcp',
      env,
      streamApiUrl: 'https://memory.example.test',
      streamToken: 'tid.secret',
      memoryInstallMode: 'personal-and-shared',
    })
    expect(steps.map((s) => s.id)).toEqual(['deps', 'pull-model', 'compose-up', 'wait-postgres', 'prisma-migrate', 'rls', 'seed', 'restart-app', 'wait-mcp', 'verify', 'shared-connect', 'register', 'write-rule'])
  })
  it('client flow with personal isolation installs the local private stack first', () => {
    const personal = buildSteps({ flow: 'engine', personalMemoryEnabled: true, mcpRuntime: 'node', env })
    expect(personal.map((s) => s.id)).toEqual([
      'deps',
      'pull-model',
      'compose-up',
      'wait-postgres',
      'prisma-migrate',
      'rls',
      'seed',
      'restart-app',
      'wait-mcp',
      'verify',
      'register',
      'write-rule',
    ])
    expect(personal.find((s) => s.id === 'compose-up')?.envOverride?.COMPOSE_PROFILES).toBe('mcp-stream')
  })
  it('client flow with personal isolation can use the shared stream service', () => {
    const personal = buildSteps({ flow: 'engine', personalMemoryEnabled: true, mcpRuntime: 'stream', env })
    expect(personal.map((s) => s.id)).toEqual([
      'deps',
      'pull-model',
      'compose-up',
      'wait-postgres',
      'prisma-migrate',
      'rls',
      'seed',
      'restart-app',
      'wait-mcp',
      'verify',
      'register',
      'write-rule',
    ])
    expect(personal.find((s) => s.id === 'compose-up')?.envOverride?.COMPOSE_PROFILES).toBe('mcp-stream')
  })
  it('pull-model carries the server pin; register/write-rule are fn steps', () => {
    const eng = buildSteps({ flow: 'engine', env, memoryInstallMode: 'personal-and-shared', pullModel: 'qwen3-embedding:8b' })
    expect(eng.find((s) => s.id === 'pull-shared-model')!.cmd).toEqual(['ollama', 'pull', 'qwen3-embedding:8b'])
    const steps = buildSteps({ flow: 'mcp', env })
    expect(steps.find((s) => s.id === 'register')!.fnId).toBe('register')
    expect(steps.find((s) => s.id === 'write-rule')!.fnId).toBe('write-rule')
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync as rf, rmSync, writeFileSync as wf } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pjoin } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerClaudeWrite, registerCodexWrite } from '../server/register.ts'
import { writeRuleTargets } from '../server/rule.ts'
import { refreshAgentInstall } from '../server/agent-update.ts'

describe('IO writers (integration, real tmp files)', () => {
  it('registerClaudeWrite (global) adds our entry, preserves a sibling mem0', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'pm-reg-'))
    const path = pjoin(dir, '.claude.json')
    wf(path, JSON.stringify({ mcpServers: { mem0: { command: 'x' } } }))
    registerClaudeWrite({ path, level: 'global', entry: buildMcpEntry(LEGACY_NODE) })
    const json = JSON.parse(rf(path, 'utf8'))
    expect(json.mcpServers.mem0).toEqual({ command: 'x' })
    expect(json.mcpServers['persistent-memory']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8091/mcp',
    })
    rmSync(dir, { recursive: true, force: true })
  })
  it('registerCodexWrite appends our table, preserving a neighbor; idempotent', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'pm-reg-'))
    const path = pjoin(dir, 'config.toml')
    wf(path, '[mcp_servers.other]\ncommand = "y"\n')
    registerCodexWrite(path, buildMcpEntry(DOCKER))
    const once = rf(path, 'utf8')
    expect(once).toContain('[mcp_servers.other]')
    expect(once).toContain('[mcp_servers.persistent-memory]')
    registerCodexWrite(path, buildMcpEntry(DOCKER))
    expect(rf(path, 'utf8')).toBe(once) // idempotent on disk
    rmSync(dir, { recursive: true, force: true })
  })
  it('legacy full-local Node MCP registration is stream-only and carries no token env', () => {
    const entry = buildMcpEntry({ ...LEGACY_NODE, token: '' })
    expect(entry).toEqual({ type: 'http', url: 'http://127.0.0.1:8091/mcp' })
  })
  it('writeRuleTargets writes the rule body + an idempotent top memory block in CLAUDE.md', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'pm-rule-'))
    const targets = targetMemoryFiles({ claude: true, codex: false, level: 'project', projectPaths: [dir], home: '/h' })
    wf(pjoin(dir, 'CLAUDE.md'), '# Existing title\n\n- @.claude/rules/persistent-memory.md — old generated line.\n\n## Git Safety\n\nKeep changes safe.\n')
    writeRuleTargets(targets, '# RULE BODY\ncontent\n', defaultMemoryBlock('@rules/persistent-memory.md'))
    const claudeMd = rf(pjoin(dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd.startsWith('# Existing title\n\n## Persistent Memory Usage (MANDATORY)')).toBe(true)
    expect(claudeMd).toContain('@.claude/rules/persistent-memory.md')
    expect(claudeMd).not.toContain('old generated line')
    expect(rf(pjoin(dir, '.claude/rules/persistent-memory.md'), 'utf8')).toContain('RULE BODY')
    writeRuleTargets(targets, '# RULE BODY\ncontent\n', defaultMemoryBlock('@rules/persistent-memory.md')) // re-run
    expect(rf(pjoin(dir, 'CLAUDE.md'), 'utf8')).toBe(claudeMd) // no duplicate block
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('refreshAgentInstall (update-script agent config migration)', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))

  it('refreshes existing Claude/Codex registrations and generated rule blocks without touching siblings', () => {
    const home = mkdtempSync(pjoin(tmpdir(), 'pm-agent-update-'))
    try {
      mkdirSync(pjoin(home, '.codex'), { recursive: true })
      mkdirSync(pjoin(home, '.claude'), { recursive: true })
      wf(pjoin(home, '.claude.json'), JSON.stringify({
        theme: 'dark',
        mcpServers: {
          mem0: { command: 'mem0' },
          'persistent-memory': { type: 'http', url: 'http://127.0.0.1:7000/mcp' },
        },
      }, null, 2))
      wf(pjoin(home, '.codex', 'config.toml'), [
        '[mcp_servers.other]',
        'command = "other"',
        '',
        '[mcp_servers.persistent-memory]',
        'url = "http://127.0.0.1:7000/mcp"',
        '',
      ].join('\n'))
      wf(pjoin(home, '.claude', 'CLAUDE.md'), [
        '# Claude rules',
        '',
        '## Persistent Memory Usage (MANDATORY)',
        '',
        '- old generated block',
        '',
        '## Git Safety',
        '',
        'Keep changes safe.',
        '',
      ].join('\n'))
      wf(pjoin(home, '.codex', 'AGENTS.md'), [
        '# Codex rules',
        '',
        '- @rules/persistent-memory.md — team-shared memory protocol (persistent-memory MCP): old line.',
        '',
        '## Git Safety',
        '',
        'Keep changes safe.',
        '',
      ].join('\n'))

      const result = refreshAgentInstall({
        root,
        home,
        env: {
          DEPLOYMENT_MODE: 'local',
          PM_MCP_RUNTIME: 'stream',
          PM_MCP_STREAM_URL: 'http://127.0.0.1:8091/mcp',
          OLLAMA_URL: 'http://host.docker.internal:11434',
          PM_MEMORY_INSTALL_MODE: 'personal-only',
          PM_DEFAULT_MEMORY_SURFACE: 'personal',
          PM_PERSONAL_API_URL: 'http://localhost:8090',
        },
      })

      expect(result.registrationWrites).toBe(2)
      expect(result.ruleWrites).toBe(2)

      const claudeJson = JSON.parse(rf(pjoin(home, '.claude.json'), 'utf8'))
      expect(claudeJson.theme).toBe('dark')
      expect(claudeJson.mcpServers.mem0).toEqual({ command: 'mem0' })
      expect(claudeJson.mcpServers['persistent-memory']).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:8091/mcp',
      })

      const codexToml = rf(pjoin(home, '.codex', 'config.toml'), 'utf8')
      expect(codexToml).toContain('[mcp_servers.other]')
      expect(codexToml).toContain('url = "http://127.0.0.1:8091/mcp"')
      expect(codexToml).not.toContain('127.0.0.1:7000')

      expect(rf(pjoin(home, '.claude', 'rules', 'persistent-memory.md'), 'utf8')).toContain('recall_context')
      expect(rf(pjoin(home, '.codex', 'rules', 'persistent-memory.md'), 'utf8')).toContain('recall_context')
      expect(rf(pjoin(home, '.claude', 'CLAUDE.md'), 'utf8')).not.toContain('old generated block')
      expect(rf(pjoin(home, '.codex', 'AGENTS.md'), 'utf8')).not.toContain('old line')
      expect(rf(pjoin(home, '.claude', 'rules', 'persistent-memory.md'), 'utf8')).toContain('## Work through unknowns')
      expect(rf(pjoin(home, '.codex', 'rules', 'persistent-memory.md'), 'utf8')).toContain('## Work through unknowns')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refreshes only Claude artifacts when the existing install is Claude-only', () => {
    const home = mkdtempSync(pjoin(tmpdir(), 'pm-agent-update-'))
    try {
      mkdirSync(pjoin(home, '.claude'), { recursive: true })
      mkdirSync(pjoin(home, '.codex'), { recursive: true })
      wf(pjoin(home, '.claude.json'), JSON.stringify({
        mcpServers: {
          'persistent-memory': { type: 'http', url: 'http://127.0.0.1:7000/mcp' },
        },
      }, null, 2))
      wf(pjoin(home, '.claude', 'CLAUDE.md'), '# Claude rules\n\n## Git Safety\n\nKeep changes safe.\n')
      wf(pjoin(home, '.codex', 'config.toml'), '[mcp_servers.other]\ncommand = "other"\n')

      const result = refreshAgentInstall({
        root,
        home,
        env: {
          DEPLOYMENT_MODE: 'local',
          PM_MCP_RUNTIME: 'stream',
          PM_MCP_STREAM_URL: 'http://127.0.0.1:8091/mcp',
          PM_MEMORY_INSTALL_MODE: 'personal-only',
          PM_DEFAULT_MEMORY_SURFACE: 'personal',
          PM_PERSONAL_API_URL: 'http://localhost:8090',
        },
      })

      expect(result.registrationWrites).toBe(1)
      expect(result.ruleWrites).toBe(1)
      expect(existsSync(pjoin(home, '.claude', 'rules', 'persistent-memory.md'))).toBe(true)
      expect(rf(pjoin(home, '.claude', 'rules', 'persistent-memory.md'), 'utf8')).toContain('## Work through unknowns')
      expect(existsSync(pjoin(home, '.codex', 'AGENTS.md'))).toBe(false)
      expect(existsSync(pjoin(home, '.codex', 'rules', 'persistent-memory.md'))).toBe(false)
      expect(rf(pjoin(home, '.codex', 'config.toml'), 'utf8')).not.toContain('persistent-memory')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refreshes only Codex artifacts when the existing install is Codex-only', () => {
    const home = mkdtempSync(pjoin(tmpdir(), 'pm-agent-update-'))
    try {
      mkdirSync(pjoin(home, '.codex'), { recursive: true })
      wf(pjoin(home, '.codex', 'config.toml'), [
        '[mcp_servers.persistent-memory]',
        'url = "http://127.0.0.1:7000/mcp"',
        '',
      ].join('\n'))
      wf(pjoin(home, '.codex', 'AGENTS.md'), '# Codex rules\n\n## Git Safety\n\nKeep changes safe.\n')

      const result = refreshAgentInstall({
        root,
        home,
        env: {
          DEPLOYMENT_MODE: 'local',
          PM_MCP_RUNTIME: 'stream',
          PM_MCP_STREAM_URL: 'http://127.0.0.1:8091/mcp',
          PM_MEMORY_INSTALL_MODE: 'personal-only',
          PM_DEFAULT_MEMORY_SURFACE: 'personal',
          PM_PERSONAL_API_URL: 'http://localhost:8090',
        },
      })

      expect(result.registrationWrites).toBe(1)
      expect(result.ruleWrites).toBe(1)
      expect(existsSync(pjoin(home, '.codex', 'rules', 'persistent-memory.md'))).toBe(true)
      expect(rf(pjoin(home, '.codex', 'rules', 'persistent-memory.md'), 'utf8')).toContain('## Work through unknowns')
      expect(existsSync(pjoin(home, '.claude.json'))).toBe(false)
      expect(existsSync(pjoin(home, '.claude', 'CLAUDE.md'))).toBe(false)
      expect(existsSync(pjoin(home, '.claude', 'rules', 'persistent-memory.md'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('upgrades existing node MCP entries to stream registration without preserving connector secrets in config files', () => {
    const home = mkdtempSync(pjoin(tmpdir(), 'pm-agent-update-'))
    try {
      mkdirSync(pjoin(home, '.codex'), { recursive: true })
      wf(pjoin(home, '.codex', 'config.toml'), [
        '[mcp_servers.persistent-memory]',
        'command = "/old/mcp/persistent-memory-mcp.sh"',
        '',
        '[mcp_servers.persistent-memory.env]',
        'API_URL = "https://memory.example.test"',
        'OLLAMA_URL = "http://localhost:11434"',
        'PM_USER_TOKEN = "tid.oldsecret"',
        'PM_MCP_CLIENT_NAME = "codex"',
        '',
      ].join('\n'))

      const result = refreshAgentInstall({
        root,
        home,
        env: {
          DEPLOYMENT_MODE: 'server',
          PM_MCP_RUNTIME: 'node',
          OLLAMA_URL: 'http://localhost:11434',
          PM_MEMORY_INSTALL_MODE: 'shared-only',
        },
      })

      expect(result.registrationWrites).toBe(1)
      const out = rf(pjoin(home, '.codex', 'config.toml'), 'utf8')
      expect(out).toContain('url = "http://127.0.0.1:8091/mcp"')
      expect(out).not.toContain('command =')
      expect(out).not.toContain('PM_USER_TOKEN')
      expect(out).not.toContain('tid.oldsecret')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not create agent files when no persistent-memory install artifact exists', () => {
    const home = mkdtempSync(pjoin(tmpdir(), 'pm-agent-update-'))
    try {
      const result = refreshAgentInstall({
        root,
        home,
        env: { DEPLOYMENT_MODE: 'local', PM_MCP_RUNTIME: 'stream' },
      })
      expect(result.registrationWrites).toBe(0)
      expect(result.ruleWrites).toBe(0)
      expect(existsSync(pjoin(home, '.claude.json'))).toBe(false)
      expect(existsSync(pjoin(home, '.codex', 'AGENTS.md'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

import { nextPhase, prevPhase } from '../web/src/flow.ts'

describe('nextPhase / prevPhase (per flow)', () => {
  it('personal-first: get started → prereqs → account → embedding → extraction → updates → … → review → shared → install', () => {
    expect(nextPhase('flow', 'full')).toBe('prereqs')
    expect(nextPhase('prereqs', 'full')).toBe('account')
    expect(nextPhase('account', 'full')).toBe('embedding')
    expect(nextPhase('embedding', 'full')).toBe('extraction')
    expect(nextPhase('extraction', 'full')).toBe('updates')
    expect(nextPhase('updates', 'full')).toBe('ecosystem')
    expect(nextPhase('rule', 'full')).toBe('review')
    expect(nextPhase('review', 'full')).toBe('shared')
    expect(nextPhase('shared', 'full')).toBe('install')
  })
  it('legacy engine flow aliases to the same personal-first phase sequence', () => {
    expect(nextPhase('flow', 'engine')).toBe('prereqs')
    expect(nextPhase('prereqs', 'engine')).toBe('account')
    expect(nextPhase('account', 'engine')).toBe('embedding')
    expect(nextPhase('review', 'engine')).toBe('shared')
    expect(nextPhase('shared', 'engine')).toBe('install')
  })
  it('legacy engine personal-isolation options do not change the personal-first sequence', () => {
    const personal = { personalMemoryEnabled: true }
    expect(nextPhase('flow', 'engine', personal)).toBe('prereqs')
    expect(nextPhase('prereqs', 'engine', personal)).toBe('account')
    expect(nextPhase('account', 'engine', personal)).toBe('embedding')
    expect(nextPhase('review', 'engine', personal)).toBe('shared')
    expect(nextPhase('shared', 'engine', personal)).toBe('install')
  })
  it('legacy mcp flow aliases to the same personal-first phase sequence', () => {
    expect(nextPhase('flow', 'mcp')).toBe('prereqs')
    expect(nextPhase('prereqs', 'mcp')).toBe('account')
    expect(nextPhase('review', 'mcp')).toBe('shared')
    expect(nextPhase('shared', 'mcp')).toBe('install')
  })
  it('legacy mcp personal-isolation options do not change the personal-first sequence', () => {
    const personal = { personalMemoryEnabled: true }
    expect(nextPhase('flow', 'mcp', personal)).toBe('prereqs')
    expect(nextPhase('prereqs', 'mcp', personal)).toBe('account')
    expect(nextPhase('account', 'mcp', personal)).toBe('embedding')
    expect(nextPhase('embedding', 'mcp', personal)).toBe('extraction')
    expect(nextPhase('rule', 'mcp', personal)).toBe('review')
    expect(nextPhase('review', 'mcp', personal)).toBe('shared')
  })
  it('shared connection happens after personal setup and uses the connector token identity', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(app).toContain('interface RemoteIdentity')
    expect(app).toContain('setRemoteIdentity')
    expect(app).toContain("serverPin?.dashboardLoginMode === 'sso'")
    expect(app).toContain('Connect Shared Memories')
    expect(app).toContain('sharedConnectEnabled')
  })
  it('remote server config maps the API active embedding pin into the wizard pin', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(app).toContain('config.activeModel')
    expect(app).toContain('config.activeDim')
    expect(app).toContain('config.embeddingTopology')
    expect(app).toContain('dashboardLoginMode: config.dashboardLoginMode')
  })
  it('registration is stream-only for every migrated flow', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(app).toContain('const streamAvailable = true')
    expect(app).toContain("mcpRuntime: 'stream'")
    expect(app).not.toMatch(/Standard\s+local\s+Node/)
  })
  it('uses product-start copy instead of the old flow card', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(app).toContain("flow: 'Get started'")
    expect(app).toContain("const RAIL_HEADING = 'INSTALLATION STEPS'")
    expect(app).toContain('Welcome to Persistent Memory')
    expect(app).toContain('supports sharing memories')
    expect(app).not.toContain('Personal-first')
    expect(app).not.toContain('flowcard-pill')
    expect(app).toContain("setPhaseAndResetGate('prereqs')")
    expect(app).not.toContain('Dashboard URL')
    expect(app).not.toContain('/api/dashboard-url')
    expect(app).not.toContain('Custom local domain')
    expect(app).not.toContain('Register domain')
  })
  it('renames prerequisites and keeps a fixed four-card pre-check surface', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(app).toContain("prereqs: 'Environment pre-check'")
    expect(app).toContain('const PREREQ_ITEMS')
    expect(app).toContain("key: 'node', label: 'Node 20+'")
    expect(app).toContain("key: 'docker', label: 'Docker daemon'")
    expect(app).toContain("key: 'compose', label: 'Docker Compose v2'")
    expect(app).toContain("key: 'ollama', label: 'Ollama (host)'")
    expect(app).toContain("type PrecheckStatus = 'pending' | 'verifying' | 'installing' | 'ok' | 'warn'")
    expect(app).not.toContain('Re-check')
  })
  it('account, extraction, updates, registration, review, and shared steps carry the corrected UI cues', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(app).toContain('<h2>Your account</h2>')
    expect(app).not.toContain('<h2>Your team & account</h2>')
    expect(app).toContain('Dashboard password (optional)')
    expect(app).toContain('ANTHROPIC_API_KEY (mandatory)')
    expect(app).toContain('OPENAI_API_KEY (mandatory)')
    expect(app).toContain('Test fact extraction')
    expect(app).toContain('/api/extraction/test')
    expect(app).toContain('extractionTestPassed')
    expect(app).toContain('Enable dashboard notifications about the available release update')
    expect(app).toContain('Test Bitbucket connection')
    expect(app).toContain('VPN connection is UP')
    expect(app).toContain('Global Level <span className="seg-badge">recommended</span>')
    expect(app).toContain('review-env-terminal')
    expect(app).toContain('shared-connect-body')
  })
  it('does not re-enable Next from a parent phase effect after extraction reports blocked', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(app).not.toContain('useEffect(() => { setNextDisabled(false) }, [phase])')
    expect(app).toContain('const setPhaseAndResetGate = (p: Phase | null) => {')
    expect(app).toContain('goto={setPhaseAndResetGate}')
  })
  it('prev mirrors next; ends are null', () => {
    expect(prevPhase('prereqs', 'full')).toBe('flow')
    expect(prevPhase('flow', 'full')).toBeNull()
    expect(nextPhase('done', 'full')).toBeNull()
  })
})
