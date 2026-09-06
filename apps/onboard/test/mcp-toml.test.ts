import { describe, expect, it } from 'vitest'
import { findPersistentMemoryTomlTables, mergeCodexToml, readPersistentMemoryTomlEntry } from '../server/mcp-toml.ts'

const block = '[mcp_servers.persistent-memory]\nurl = "http://127.0.0.1:8091/mcp"\n'

describe('Codex TOML registration preservation', () => {
  it.each([
    '[mcp_servers.persistent-memory]',
    '[ mcp_servers . "persistent-memory" ] # original table comment',
    "['mcp_servers'.'persistent-memory'] # original table comment",
    '["mcp_servers"."persistent\\u002dmemory"]',
  ])('replaces the supported header %s without duplicates', header => {
    const text = `model = "keep"\n${header}\ncommand = "old"\n[mcp_servers.other]\ncommand = 'C:\\Tools\\other.exe'\n`
    const merged = mergeCodexToml(text, block)
    expect(findPersistentMemoryTomlTables(merged)).toHaveLength(1)
    expect(merged).not.toContain('command = "old"')
    expect(merged.startsWith('model = "keep"\n')).toBe(true)
    expect(merged.endsWith("[mcp_servers.other]\ncommand = 'C:\\Tools\\other.exe'\n")).toBe(true)
    if (header.includes('#')) expect(merged).toContain('# original table comment')
    expect(mergeCodexToml(merged, block)).toBe(merged)
  })

  it('preserves Windows CRLF, Unicode, BOM, and unrelated comments byte-for-byte', () => {
    const before = '\uFEFF# 私の設定\r\nmodel = "keep"\r\n\r\n'
    const after = '[projects."C:\\\\Users\\\\Zoë\\\\Work"] # folder\r\ntrust_level = "trusted"\r\n'
    const text = before + '[mcp_servers.persistent-memory] # local memory\r\ncommand = "old" # old launcher\r\n# next settings\r\n' + after
    const merged = mergeCodexToml(text, block)
    expect(merged.startsWith(before)).toBe(true)
    expect(merged.endsWith(after)).toBe(true)
    expect(merged).toContain('# local memory\r\n# old launcher\r\n# next settings\r\n')
    expect(merged.replace(/\r\n/g, '')).not.toContain('\n')
    expect(mergeCodexToml(merged, block)).toBe(merged)
  })

  it.each(['"""', "'''"])('does not treat table-like lines inside %s multiline strings as headers', quote => {
    const text = `instructions = ${quote}\n[mcp_servers.persistent-memory]\ncommand = "this is documentation"\n# example comment\n${quote}\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n`
    const merged = mergeCodexToml(text, block)
    expect(merged.startsWith(text)).toBe(true)
    expect(findPersistentMemoryTomlTables(merged)).toHaveLength(1)
    expect(readPersistentMemoryTomlEntry(text)).toBeNull()
    expect(readPersistentMemoryTomlEntry(merged)?.url).toBe('http://127.0.0.1:8091/mcp')
  })

  it('handles escaped quotes and multiline arrays before real headers', () => {
    const before = 'instructions = """\nAn escaped delimiter: \\"""\n[mcp_servers.persistent-memory]\n"""\nvalues = [\n ["one", "two"],\n "[mcp_servers.persistent-memory]",\n]\n'
    const merged = mergeCodexToml(before + '[mcp_servers.persistent-memory]\ncommand = "old"\n', block)
    expect(merged.startsWith(before)).toBe(true)
    expect(merged.endsWith(block)).toBe(true)
  })

  it('removes separated owned subtables while preserving foreign tables and array tables', () => {
    const middle = '[mcp_servers.other]\nurl = "https://other.example"\n[[custom.items]]\nname = "untouched"\n'
    const text = '[mcp_servers.persistent-memory]\ncommand = "old"\n' + middle + "[mcp_servers.'persistent-memory'.env] # legacy environment\nOLD_TOKEN = 'old'\n"
    const merged = mergeCodexToml(text, block)
    expect(merged).toContain(middle)
    expect(merged).toContain('# legacy environment')
    expect(merged).not.toContain('OLD_TOKEN')
    expect(findPersistentMemoryTomlTables(merged)).toHaveLength(1)
    expect(mergeCodexToml(merged, block)).toBe(merged)
  })

  it('does not replace a distinct quoted server name containing a dot', () => {
    const text = '[mcp_servers."persistent-memory.other"]\nurl = "https://other.example"\n'
    expect(mergeCodexToml(text, block).startsWith(text)).toBe(true)
  })

  it('reads commented quoted tables and literal Windows paths for the update path', () => {
    const text = "['mcp_servers'.'persistent-memory'] # my server\ncommand = 'C:\\Programs\\server.exe' # launcher\nurl = 'http://127.0.0.1:8091/mcp'\n[mcp_servers.other]\nurl = 'https://other.example'\n[mcp_servers.\"persistent-memory\".'env'] # env\nPM_MCP_CLIENT_NAME = 'codex-desktop'\n"
    expect(readPersistentMemoryTomlEntry(text)).toEqual({
      command: 'C:\\Programs\\server.exe', url: 'http://127.0.0.1:8091/mcp', env: { PM_MCP_CLIENT_NAME: 'codex-desktop' },
    })
  })

  it.each([
    'instructions = """unterminated\n[mcp_servers.persistent-memory]\n',
    '[mcp_servers.persistent-memory\ncommand = "old"\n',
    'mcp_servers = { persistent-memory = { url = "old" } }\n',
    '[mcp_servers]\npersistent-memory = { url = "old" }\n',
    'mcp_servers.persistent-memory.url = "old"\n',
    '[[mcp_servers.persistent-memory]]\nurl = "old"\n',
  ])('refuses ambiguous or unsupported definitions instead of corrupting them', text => {
    expect(() => mergeCodexToml(text, block)).toThrow('Cannot safely update')
  })
})
