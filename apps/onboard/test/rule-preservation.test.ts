import { describe, expect, it } from 'vitest'
import { defaultMemoryBlock, injectMemoryBlock } from '../server/rule.ts'

const BEGIN = '<!-- persistent-memory:begin -->'
const END = '<!-- persistent-memory:end -->'
const defaultBlock = defaultMemoryBlock('@rules/persistent-memory.md')

describe('managed memory instruction preservation', () => {
  it('keeps unheaded user prose after a title through repeated default installs', () => {
    const original = '# My instructions\n\nKeep this unrelated guidance.\n\n- Preserve this user list item.\n'
    const once = injectMemoryBlock(original, defaultBlock)
    const twice = injectMemoryBlock(once, defaultBlock)
    expect(twice).toBe(once)
    expect(twice).toContain('Keep this unrelated guidance.\n\n- Preserve this user list item.')
    expect(twice.indexOf(END)).toBeLessThan(twice.indexOf('Keep this unrelated guidance.'))
    expect(twice.match(/persistent-memory:begin/g)).toHaveLength(1)
  })

  it('keeps unheaded prose without a title through repeated installs', () => {
    const original = 'Use this private development convention.\n\nKeep these three blank lines.\n\n\n\nStill user content.\n'
    const once = injectMemoryBlock(original, defaultBlock)
    expect(injectMemoryBlock(once, defaultBlock)).toBe(once)
    expect(once.endsWith(original)).toBe(true)
  })

  it('replaces the full custom block, including its own headings, and nothing beyond it', () => {
    const original = '# My instructions\n\nKeep my prose.\n\n### My lower-level heading\nKeep its list.\n'
    const first = '## My memory procedure\n\nCustom first procedure.\n\n### Extra managed section\nManaged details.'
    const second = '## My changed memory procedure\n\nCustom second procedure.\n\n# Another managed heading\nNew managed details.'
    const once = injectMemoryBlock(original, first)
    expect(injectMemoryBlock(once, first)).toBe(once)
    const updated = injectMemoryBlock(once, second)
    expect(updated).not.toContain('Custom first procedure.')
    expect(updated).toContain(second)
    expect(updated).toContain('Keep my prose.\n\n### My lower-level heading\nKeep its list.')
    expect(injectMemoryBlock(updated, second)).toBe(updated)
  })

  it('migrates a recognized legacy default block and preserves following unheaded prose', () => {
    const old = defaultBlock.replace('Detailed protocol: read ', 'Detailed protocol: ')
      .replace('before using memory tools.', '(auto-loaded when this file is read).')
    const original = '# My instructions\n\n' + old + '\nKeep unrelated user prose.\n- My own policy.\n'
    const once = injectMemoryBlock(original, defaultBlock)
    expect(once).not.toContain('auto-loaded')
    expect(once.match(/Persistent Memory Usage \(MANDATORY\)/g)).toHaveLength(1)
    expect(once).toContain('Keep unrelated user prose.\n- My own policy.')
    expect(injectMemoryBlock(once, defaultBlock)).toBe(once)
  })

  it('preserves unrecognized legacy prose and bullets even under a familiar heading', () => {
    const original = '## Persistent Memory Usage (MANDATORY)\n\nOur team stores memory snapshots in a vault.\n- Never delete a vault snapshot.\n'
    const once = injectMemoryBlock(original, defaultBlock)
    expect(once.endsWith(original)).toBe(true)
    expect(injectMemoryBlock(once, defaultBlock)).toBe(once)
  })

  it('stops legacy cleanup at the first unknown bullet instead of assuming the entire section is generated', () => {
    const original = '## Persistent Memory Usage (MANDATORY)\n\n- Detailed protocol: @rules/persistent-memory.md\n- Keep this unrelated bullet.\n\nUser paragraph.\n'
    const once = injectMemoryBlock(original, defaultBlock)
    expect(once).toContain('- Keep this unrelated bullet.\n\nUser paragraph.')
    expect(injectMemoryBlock(once, defaultBlock)).toBe(once)
  })

  it('removes known legacy trigger/issue lines while preserving the next unknown paragraph', () => {
    const original = [
      '## Memory Save Triggers (MANDATORY)',
      'When any of these happen, STOP and call `add_memory` IMMEDIATELY in the same response — not "later", not "at session end":',
      '- **User corrects you** — save what you tried, why it was wrong, the correction, the right approach. Highest-value learning.',
      'Keep my trigger note.',
      '## Mem0 Issues (MANDATORY)',
      'If any mem0 tool call fails or returns suspect output, NOTIFY the user.',
      '- **401 `AuthenticationError`** — mem0 MCP cached token expired.',
      'Keep my incident note.',
    ].join('\n')
    const once = injectMemoryBlock(original, defaultBlock)
    expect(once).not.toContain('Memory Save Triggers')
    expect(once).not.toContain('mem0 MCP cached token expired')
    expect(once).toContain('Keep my trigger note.')
    expect(once).toContain('Keep my incident note.')
  })

  it.each(['```markdown', '~~~markdown'])('preserves marker and legacy-heading examples inside %s fences', fence => {
    const original = [fence, BEGIN, '## Persistent Memory Usage (MANDATORY)', '- Detailed protocol: @rules/persistent-memory.md', END, fence.slice(0, 3), 'User prose.'].join('\n') + '\n'
    const once = injectMemoryBlock(original, defaultBlock)
    expect(once.endsWith(original)).toBe(true)
    expect(injectMemoryBlock(once, defaultBlock)).toBe(once)
  })

  it('keeps indented code examples untouched', () => {
    const original = `    ${BEGIN}\n    ## Persistent Memory Usage (MANDATORY)\n    - Detailed protocol: @rules/persistent-memory.md\n    ${END}\n`
    const once = injectMemoryBlock('# Guide\n\n' + original, defaultBlock)
    expect(once).toContain(original.trimEnd())
    expect(injectMemoryBlock(once, defaultBlock)).toBe(once)
  })

  it.each([
    `${BEGIN}\nKeep this after an unmatched begin.\n`,
    `Keep this before an unmatched end.\n${END}\n`,
    `${BEGIN}\n${BEGIN}\nNever delete this nested content.\n${END}\n`,
  ])('fails closed on malformed ownership markers', original => {
    expect(() => injectMemoryBlock(original, defaultBlock)).toThrow('existing instructions were not changed')
  })
})
