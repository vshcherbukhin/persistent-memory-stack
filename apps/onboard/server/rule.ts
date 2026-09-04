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

const RULE_BASENAME = 'persistent-memory.md'
const MEMORY_BLOCK_HEADING = '## Persistent Memory Usage (MANDATORY)'
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

- Detailed protocol: ${ruleRef} (auto-loaded when this file is read). Treat that rule as the source of truth for tool order, memory shapes, and save/update/delete rules.
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

function stripGeneratedMemoryBlocks(md: string): string {
  const lines = md.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? ''
    const heading = line.trim()
    if (GENERATED_MEMORY_HEADINGS.has(heading)) {
      i++
      while (i < lines.length && !/^#{1,2}\s+/.test((lines[i] ?? '').trim())) i++
      continue
    }
    if (isLegacyRefLine(line)) {
      i++
      continue
    }
    kept.push(line)
    i++
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

function materializeMemoryBlock(block: string, ruleRef: string): string {
  let out = block.trim()
  if (out.includes(RULE_REF_TOKEN)) out = out.replaceAll(RULE_REF_TOKEN, ruleRef)
  else {
    const replaced = out.replace(RULE_REF_PATTERN, ruleRef)
    if (replaced !== out) out = replaced
  }
  if (!out.includes(RULE_BASENAME)) {
    const lines = out.split('\n')
    const insertAt = lines.findIndex((line) => line.trim() === MEMORY_BLOCK_HEADING)
    const detail = `- Detailed protocol: ${ruleRef} (auto-loaded when this file is read).`
    if (insertAt >= 0) lines.splice(insertAt + 1, 0, '', detail)
    else lines.unshift(MEMORY_BLOCK_HEADING, '', detail)
    out = lines.join('\n')
  }
  return out.replace(/\s+$/, '') + '\n'
}

/** Replace old generated memory snippets and place the block as the first real section. */
export function injectMemoryBlock(md: string, memoryBlock: string): string {
  const block = memoryBlock.trim()
  const cleaned = stripGeneratedMemoryBlocks(md).replace(/\s+$/, '')
  if (cleaned.trim() === '') return block + '\n'

  const lines = cleaned.replace(/^\s+/, '').split('\n')
  if (/^#\s+/.test(lines[0] ?? '')) {
    const title = lines[0]!
    const rest = lines.slice(1).join('\n').replace(/^\s+/, '')
    return [title, '', block, rest].filter((part) => part !== '').join('\n\n') + '\n'
  }
  return block + '\n\n' + cleaned.replace(/^\s+/, '') + '\n'
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
}

/** Resolve which CLAUDE.md/AGENTS.md files get the memory block + where the rule body lands. */
export function targetMemoryFiles(input: TargetInput): RuleTarget[] {
  const out: RuleTarget[] = []
  const add = (kind: 'claude' | 'codex', baseDir: string, memoryDir: string, memoryName: string) => {
    out.push({
      kind,
      memoryFile: join(memoryDir, memoryName),
      ruleFile: join(baseDir, 'rules', RULE_BASENAME),
      // ref is relative to the memory file's directory.
      ruleRef: memoryDir === baseDir ? `@rules/${RULE_BASENAME}` : `@.${kind}/rules/${RULE_BASENAME}`,
    })
  }
  if (input.level === 'global') {
    if (input.claude) add('claude', join(input.home, '.claude'), join(input.home, '.claude'), 'CLAUDE.md')
    if (input.codex) add('codex', join(input.home, '.codex'), join(input.home, '.codex'), 'AGENTS.md')
  } else {
    for (const p of input.projectPaths) {
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
    mkdirSync(dirname(t.ruleFile), { recursive: true })
    writeFileSync(t.ruleFile, ruleBody.endsWith('\n') ? ruleBody : ruleBody + '\n')
    const current = existsSync(t.memoryFile) ? readFileSync(t.memoryFile, 'utf8') : ''
    mkdirSync(dirname(t.memoryFile), { recursive: true })
    const block = materializeMemoryBlock(memoryBlock?.trim() ? memoryBlock : defaultMemoryBlock(t.ruleRef), t.ruleRef)
    writeFileSync(t.memoryFile, injectMemoryBlock(current, block))
  }
}
