import { describe, expect, it } from 'vitest'
import { mergeManagedRule } from '../server/rule.ts'

const BEGIN = '<!-- persistent-memory:rule-begin -->'
const END = '<!-- persistent-memory:rule-end -->'

describe('detailed protocol ownership', () => {
  it('replaces only the marked managed region and preserves user prefix/suffix byte-for-byte', () => {
    const original = `# User policy\r\nPreserve this.\r\n${BEGIN}\nOld managed protocol.\n${END}\r\n## Private addendum\r\nKeep this too.\r\n`
    const updated = mergeManagedRule(original, '# Current protocol\n')
    expect(updated.startsWith('# User policy\r\nPreserve this.\r\n')).toBe(true)
    expect(updated.endsWith('\r\n## Private addendum\r\nKeep this too.\r\n')).toBe(true)
    expect(updated).not.toContain('Old managed protocol.')
    expect(mergeManagedRule(updated, '# Current protocol\n')).toBe(updated)
  })
  it('never treats marker examples in fenced text or inline prose as ownership', () => {
    expect(() => mergeManagedRule(`Example ${BEGIN}\nUnrelated text ${END}\n`, '# New')).toThrow('unknown ownership')
    expect(() => mergeManagedRule(`\`\`\`markdown\n${BEGIN}\n${END}\n\`\`\`\nUser text.`, '# New')).toThrow('unknown ownership')
  })
  it('leaves edited historical templates and damaged regions for explicit review', () => {
    expect(() => mergeManagedRule('# Personal custom protocol\n', '# Replacement')).toThrow('user edits')
    expect(() => mergeManagedRule(`${BEGIN}\nUser content.\n`, '# Replacement')).toThrow('damaged')
  })
})
