/**
 * persistent-memory-onboard — the top memory block + detailed memory-usage rule.
 *
 * The canonical rule body is the committed template `apps/onboard/templates/
 * persistent-memory-rule.md` (loaded via readDefaultRule, shown in the wizard for
 * the user to edit). The memory block is written at the top of CLAUDE.md/AGENTS.md
 * and links to that detailed rule. Pure helpers are unit-tested; the `*Write` IO
 * wrappers do read→replace/insert→write.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentProfiles, normalizedProjectPaths } from './agent-profiles.js'

const RULE_BASENAME = 'persistent-memory.md'
const MEMORY_BLOCK_HEADING = '## Persistent Memory Usage (MANDATORY)'
const MEMORY_BLOCK_BEGIN = '<!-- persistent-memory:begin -->'
const MEMORY_BLOCK_END = '<!-- persistent-memory:end -->'
const RULE_REF_TOKEN = '{{RULE_REF}}'
const RULE_REF_PATTERN = /@(?:\.(?:claude|codex)\/)?rules\/persistent-memory\.md/g
const GENERATED_MEMORY_HEADINGS = new Set([
  MEMORY_BLOCK_HEADING,
  '## Memory Save Triggers (MANDATORY)',
  '## Mem0 Issues (MANDATORY)',
  '## Persistent Memory Usage',
  '## Persistent Memory Protocol',
  '## Persistent Memory protocol',
])

/** Load the committed default rule body (resolved relative to this module). */
export function readDefaultRule(): string {
  const path = fileURLToPath(new URL('../templates/persistent-memory-rule.md', import.meta.url))
  return readFileSync(path, 'utf8')
}

/** The short top-of-file block written into CLAUDE.md / AGENTS.md. */
export function defaultMemoryBlock(ruleRef: string): string {
  return `${MEMORY_BLOCK_HEADING}

- Detailed protocol: read ${ruleRef} before using memory tools. Treat that rule as the source of truth for tool order, memory shapes, and save/update/delete rules.
- Start every non-trivial task by calling \`recall_context(query, project)\` before planning or editing. If the tool schema is deferred, load persistent-memory through ToolSearch/tool_search first.
- Use memory to learn the project/topic vocabulary, then verify against source files, tests, docs, or runtime evidence before changing behavior.
- If memory is missing or thin, say so briefly, continue from current evidence, and save the durable lesson once you learn it.
- Save user corrections, gotchas, fixes, decisions, tool gaps, and non-obvious workflow details immediately. Future sessions should not rediscover the same issue.
- When memory conflicts with the user or current evidence, update/delete the stale memory and save the correction.
`
}

function isLegacyRefLine(line: string): boolean {
  const trimmed = line.trim()
  return /^-\s+@(?:\.(?:claude|codex)\/)?rules\/persistent-memory\.md\b/.test(trimmed)
    && /persistent-memory|memory protocol|team-shared memory/i.test(trimmed)
}

interface MarkdownFence { character: string; length: number }

function nextFence(line: string, fence: MarkdownFence | null): MarkdownFence | null {
  const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!marker) return fence
  if (!fence) return { character: marker[1]![0]!, length: marker[1]!.length }
  return marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim() ? null : fence
}

/** Only complete explicit regions confer ownership. An incomplete marker must
 * never turn the rest of an instructions file into text that we may remove. */
function markedMemoryRegions(lines: string[]): Map<number, number> {
  const regions = new Map<number, number>()
  let start: number | null = null
  let fence: MarkdownFence | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const previousFence = fence
    fence = nextFence(line, fence)
    if (previousFence || fence || /^ {4}|^\t/.test(line)) continue
    if (line.trim() === MEMORY_BLOCK_BEGIN) {
      if (start !== null) throw new Error('Persistent-memory instruction markers are nested; existing instructions were not changed.')
      start = i
    } else if (line.trim() === MEMORY_BLOCK_END) {
      if (start === null) throw new Error('Persistent-memory instruction markers are incomplete; existing instructions were not changed.')
      regions.set(start, i)
      start = null
    }
  }
  if (start !== null) throw new Error('Persistent-memory instruction markers are incomplete; existing instructions were not changed.')
  return regions
}

function legacyGeneratedLine(line: string): boolean {
  const trimmed = line.trim()
  if (isLegacyRefLine(line)) return true
  if (/^- Detailed protocol: (?:read )?@(?:\.(?:claude|codex)\/)?rules\/persistent-memory\.md\b/.test(trimmed)) return true
  const known = new Set([
    ...defaultMemoryBlock('@rules/persistent-memory.md').split(/\r?\n/).map(value => value.trim()).filter(value => value.startsWith('- ')),
    'When any of these happen, STOP and call `add_memory` IMMEDIATELY in the same response — not "later", not "at session end":',
    '- **User corrects you** — save what you tried, why it was wrong, the correction, the right approach. Highest-value learning.',
    "- **A tool doesn't cover something you expected** — save the tool, the gap, the workaround.",
    'If any mem0 tool call fails or returns suspect output, NOTIFY the user.',
    '- **401 `AuthenticationError`** — mem0 MCP cached token expired.',
  ])
  return known.has(trimmed)
}

function stripGeneratedMemoryBlocks(md: string): string {
  const lines = md.split('\n')
  const regions = markedMemoryRegions(lines)
  const kept: string[] = []
  let fence: MarkdownFence | null = null
  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? ''
    const end = regions.get(i)
    if (end !== undefined) { i = end + 1; continue }
    const previousFence = fence
    fence = nextFence(line, fence)
    if (previousFence || fence || /^ {4}|^\t/.test(line)) {
      kept.push(line)
      i++
      continue
    }
    const heading = line.trim()
    if (GENERATED_MEMORY_HEADINGS.has(heading)) {
      // Old versions had no end marker. Consume only recognizable generated
      // lines; an unknown paragraph, list item, or heading belongs to the user.
      let next = i + 1
      let recognized = false
      while (next < lines.length) {
        const candidate = lines[next]!
        if (!candidate.trim()) { next++; continue }
        if (/^ {4}|^\t/.test(candidate) || !legacyGeneratedLine(candidate)) break
        recognized = true
        next++
      }
      if (recognized) { i = next; continue }
    }
    if (isLegacyRefLine(line)) {
      i++
      continue
    }
    kept.push(line)
    i++
  }
  return kept.join('\n')
}

function materializeMemoryBlock(block: string, ruleRef: string, kind: RuleTarget['kind']): string {
  let out = block.trim()
  if (out.includes(RULE_REF_TOKEN)) out = out.replaceAll(RULE_REF_TOKEN, ruleRef)
  else {
    const replaced = out.replace(RULE_REF_PATTERN, ruleRef)
    if (replaced !== out) out = replaced
  }
  if (!out.includes(RULE_BASENAME)) {
    const lines = out.split('\n')
    const insertAt = lines.findIndex((line) => line.trim() === MEMORY_BLOCK_HEADING)
    const detail = `- Detailed protocol: read ${ruleRef} before using memory tools.`
    if (insertAt >= 0) lines.splice(insertAt + 1, 0, '', detail)
    else lines.unshift(MEMORY_BLOCK_HEADING, '', detail)
    out = lines.join('\n')
  }
  if (kind === 'codex') out = out.replace(/\(auto-loaded when this file is read\)/g, '(read this file before using memory tools)')
  return out.replace(/\s+$/, '') + '\n'
}

/** Replace old generated memory snippets and place the block as the first real section. */
export function injectMemoryBlock(md: string, memoryBlock: string): string {
  const newline = md.includes('\r\n') ? '\r\n' : '\n'
  const bom = md.startsWith('\uFEFF') ? '\uFEFF' : ''
  const block = [MEMORY_BLOCK_BEGIN, memoryBlock.trim().replace(/\r?\n/g, newline), MEMORY_BLOCK_END].join(newline)
  // Reject a custom block containing unbalanced reserved markers or an open
  // fence that would hide its closing marker, before writing any instructions.
  markedMemoryRegions(block.split('\n'))
  const cleaned = stripGeneratedMemoryBlocks(md.slice(bom.length)).replace(/(?:\r?\n[ \t]*)+$/, '')
  if (cleaned.trim() === '') return bom + block + newline

  // Remove empty separator lines only: leading spaces can be meaningful Markdown
  // code indentation and must not become live instructions on a later pass.
  const leadingBlanks = /^(?:[ \t]*\r?\n)+/
  const content = cleaned.replace(leadingBlanks, '')
  const lines = content.split('\n')
  if (/^#\s+/.test(lines[0] ?? '')) {
    const title = lines[0]!.replace(/\r$/, '')
    const rest = lines.slice(1).join('\n').replace(leadingBlanks, '')
    return bom + [title, block, rest].filter((part) => part !== '').join(newline + newline) + newline
  }
  return bom + block + newline + newline + content + newline
}

export interface RuleTarget {
  kind: 'claude' | 'codex'
  /** CLAUDE.md / AGENTS.md to receive the top memory block. */
  memoryFile: string
  /** Where the rule body is written. */
  ruleFile: string
  /** The @-relative rule reference used in the memory block. */
  ruleRef: string
}

export interface TargetInput {
  claude: boolean
  codex: boolean
  level: 'global' | 'project'
  projectPaths: string[]
  home: string
  profileEnv?: NodeJS.ProcessEnv
}

/** Codex reads a nonempty AGENTS.override.md instead of AGENTS.md. */
export function codexMemoryFile(memoryDir: string): string {
  const override = join(memoryDir, 'AGENTS.override.md')
  return existsSync(override) && readFileSync(override, 'utf8').trim()
    ? override : join(memoryDir, 'AGENTS.md')
}

/** Resolve which CLAUDE.md/AGENTS.md files get the memory block + where the rule body lands. */
export function targetMemoryFiles(input: TargetInput): RuleTarget[] {
  const out: RuleTarget[] = []
  const add = (kind: 'claude' | 'codex', baseDir: string, memoryDir: string, memoryName: string) => {
    out.push({
      kind,
      memoryFile: kind === 'codex' ? codexMemoryFile(memoryDir) : join(memoryDir, memoryName),
      ruleFile: join(baseDir, 'rules', RULE_BASENAME),
      // ref is relative to the memory file's directory.
      ruleRef: memoryDir === baseDir ? `@rules/${RULE_BASENAME}` : `@.${kind}/rules/${RULE_BASENAME}`,
    })
  }
  if (input.level === 'global') {
    const profiles = agentProfiles(input.home, { env: input.profileEnv })
    if (input.claude) add('claude', profiles.claudeDir, profiles.claudeDir, 'CLAUDE.md')
    if (input.codex) add('codex', profiles.codexDir, profiles.codexDir, 'AGENTS.md')
  } else {
    const projects = normalizedProjectPaths(input.projectPaths)
    if (projects.length === 0) throw new Error('Project registration requires at least one absolute folder path.')
    for (const p of projects) {
      if (input.claude) add('claude', join(p, '.claude'), p, 'CLAUDE.md')
      if (input.codex) add('codex', join(p, '.codex'), p, 'AGENTS.md')
    }
  }
  return out
}

// ── IO writers (thin) ──────────────────────────────────────────────────────────

/** Write the (user-edited) rule body + replace/insert the memory block in each target. */
export function writeRuleTargets(targets: RuleTarget[], ruleBody: string, memoryBlock?: string): void {
  for (const t of targets) {
    const current = existsSync(t.memoryFile) ? readFileSync(t.memoryFile, 'utf8') : ''
    const block = materializeMemoryBlock(memoryBlock?.trim() ? memoryBlock : defaultMemoryBlock(t.ruleRef), t.ruleRef, t.kind)
    const nextMemory = injectMemoryBlock(current, block)
    // Validate/read both desired contents before touching either target file.
    mkdirSync(dirname(t.ruleFile), { recursive: true })
    mkdirSync(dirname(t.memoryFile), { recursive: true })
    writeFileSync(t.ruleFile, ruleBody.endsWith('\n') ? ruleBody : ruleBody + '\n')
    writeFileSync(t.memoryFile, nextMemory)
  }
}
