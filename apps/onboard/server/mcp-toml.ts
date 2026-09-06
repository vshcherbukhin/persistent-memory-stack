interface Assignment { keys: string[]; value: string }
interface TableRegion {
  start: number
  end: number
  keys: string[]
  comments: string[]
  assignments: Assignment[]
}

const target = (keys: string[]): boolean => keys[0] === 'mcp_servers' && keys[1] === 'persistent-memory'
const invalid = (): never => { throw new Error('Cannot safely update this Codex TOML configuration. Correct its syntax or use a [mcp_servers.persistent-memory] table before retrying.') }

function quoted(text: string, start: number): { value: string; end: number } {
  const quote = text[start]!
  let value = ''
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]!
    if (char === quote) return { value, end: i + 1 }
    if (char !== '\\' || quote === "'") { value += char; continue }
    const escaped = text[++i]!
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
    if (Object.hasOwn(simple, escaped)) { value += simple[escaped]; continue }
    const length = escaped === 'u' ? 4 : escaped === 'U' ? 8 : 0
    const digits = text.slice(i + 1, i + 1 + length)
    if (!length || digits.length !== length || !/^[0-9a-f]+$/i.test(digits)) invalid()
    const point = Number.parseInt(digits, 16)
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) invalid()
    value += String.fromCodePoint(point)
    i += length
  }
  return invalid()
}

function keyPath(text: string, start: number, terminator: string): { keys: string[]; end: number } {
  const keys: string[] = []
  let i = start
  for (;;) {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++
    if (text[i] === '"' || text[i] === "'") {
      const key = quoted(text, i)
      keys.push(key.value)
      i = key.end
    } else {
      const key = /^[A-Za-z0-9_-]+/.exec(text.slice(i))?.[0]
      if (!key) return invalid()
      keys.push(key)
      i += key.length
    }
    while (/\s/.test(text[i] ?? '') && i < text.length) i++
    if (text.startsWith(terminator, i)) return { keys, end: i }
    if (text[i] !== '.') return invalid()
    i++
  }
}

/** Locate real tables without treating strings, arrays, or comments as headers.
 * This is a lexical editor, not a serializer: unrelated text stays byte-for-byte.
 */
export function findPersistentMemoryTomlTables(text: string): TableRegion[] {
  const bom = text.startsWith('\uFEFF') ? 1 : 0
  const source = text.slice(bom)
  const tables: TableRegion[] = []
  let current: TableRegion | undefined
  let mode: 'basic' | 'literal' | 'multi-basic' | 'multi-literal' | null = null
  let arrays = 0
  let objects = 0
  let offset = bom
  for (const raw of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = raw.replace(/\r?\n$/, '')
    const neutral = mode === null && arrays === 0 && objects === 0
    const trimmed = line.trimStart()
    let assignment: { keys: string[]; end: number } | undefined
    if (neutral && trimmed.startsWith('[')) {
      const arrayTable = trimmed.startsWith('[[')
      const close = arrayTable ? ']]' : ']'
      const header = keyPath(trimmed, arrayTable ? 2 : 1, close)
      const tail = trimmed.slice(header.end + close.length).trim()
      if (tail && !tail.startsWith('#')) invalid()
      if (arrayTable && target(header.keys)) invalid()
      if (current) current.end = offset
      current = { start: offset, end: text.length, keys: header.keys, comments: [], assignments: [] }
      tables.push(current)
    } else if (neutral && trimmed && !trimmed.startsWith('#')) {
      assignment = keyPath(trimmed, 0, '=')
      const fullPath = [...(current?.keys ?? []), ...assignment.keys]
      // Dotted or inline definitions cannot safely be converted by replacing a
      // table region. Refuse rather than append an invalid duplicate definition.
      if (fullPath[0] === 'mcp_servers' && (fullPath.length === 1 || target(fullPath)) && !target(current?.keys ?? [])) invalid()
    }
    let comment = -1
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!
      if (mode === 'multi-basic' || mode === 'multi-literal') {
        const quote = mode === 'multi-basic' ? '"' : "'"
        if (mode === 'multi-basic' && char === '\\') { i++; continue }
        if (line.startsWith(quote.repeat(3), i)) {
          let length = 3
          while (line[i + length] === quote) length++
          if (length > 5) invalid()
          i += length - 1
          mode = null
        }
      } else if (mode) {
        if (mode === 'basic' && char === '\\') i++
        else if (char === (mode === 'basic' ? '"' : "'")) mode = null
      } else if (char === '#') { comment = i; break }
      else if (char === '"' || char === "'") {
        if (line.startsWith(char.repeat(3), i)) {
          mode = char === '"' ? 'multi-basic' : 'multi-literal'
          i += 2
        } else mode = char === '"' ? 'basic' : 'literal'
      } else if (char === '[') arrays++
      else if (char === ']') arrays--
      else if (char === '{') objects++
      else if (char === '}') objects--
      if (arrays < 0 || objects < 0) invalid()
    }
    if (mode === 'basic' || mode === 'literal') invalid()
    if (current && comment >= 0) {
      const ending = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : ''
      current.comments.push((line.slice(0, comment).trim() ? line.slice(comment) : line) + ending)
    }
    if (current && assignment) {
      const content = (comment < 0 ? trimmed : line.slice(0, comment).trimStart())
      current.assignments.push({ keys: assignment.keys, value: content.slice(assignment.end + 1).trim() })
    }
    offset += raw.length
  }
  if (mode !== null || arrays !== 0 || objects !== 0) invalid()
  return tables.filter(table => target(table.keys))
}

/** Replace only our tables; retain all other content and comments. */
export function mergeCodexToml(text: string, block: string): string {
  const tables = findPersistentMemoryTomlTables(text)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const replacement = block.replace(/\r\n/g, '\n').replace(/\n+$/, '').replace(/\n/g, newline) + newline
  if (!tables.length) {
    const separator = text && !text.endsWith('\n') ? newline + newline : text && !text.endsWith(newline + newline) ? newline : ''
    return text + separator + replacement
  }
  let result = ''
  let cursor = 0
  for (const [index, table] of tables.entries()) {
    result += text.slice(cursor, table.start)
    if (index === 0) result += replacement
    for (const comment of table.comments) result += comment.endsWith('\n') ? comment : comment + newline
    cursor = table.end
  }
  return result + text.slice(cursor)
}

/** Read the string values used by migration, using the same real table scan. */
export function readPersistentMemoryTomlEntry(text: string): { command?: string; url?: string; env: Record<string, string> } | null {
  const tables = findPersistentMemoryTomlTables(text)
  if (!tables.length) return null
  const entry: { command?: string; url?: string; env: Record<string, string> } = { env: {} }
  for (const table of tables) {
    for (const assignment of table.assignments) {
      if (assignment.keys.length !== 1 || !/^["']/.test(assignment.value) || /^("""|''')/.test(assignment.value)) continue
      const value = quoted(assignment.value, 0)
      if (assignment.value.slice(value.end).trim()) continue
      const key = assignment.keys[0]!
      if (table.keys.length === 3 && table.keys[2] === 'env') entry.env[key] = value.value
      else if (table.keys.length === 2 && (key === 'url' || key === 'command')) entry[key] = value.value
    }
  }
  return entry
}
