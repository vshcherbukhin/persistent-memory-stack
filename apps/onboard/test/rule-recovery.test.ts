import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ruleRepairWarning, writeRuleTargets, type RuleTarget } from '../server/rule.ts'

const faults = vi.hoisted(() => ({ backupPrefix: '' }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (faults.backupPrefix && String(args[0]).startsWith(faults.backupPrefix)) {
        throw Object.assign(new Error('fixture disk failure'), { code: 'ENOSPC' })
      }
      return actual.writeFileSync(...args)
    },
  }
})

const BEGIN = '<!-- persistent-memory:begin -->'
const END = '<!-- persistent-memory:end -->'
const fixtures: string[] = []
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'pm-rule-recovery-'))
  fixtures.push(base)
  const targets: RuleTarget[] = ['Claude Équipe', 'Codex 项目'].map((name, i) => {
    const directory = join(base, name)
    mkdirSync(directory, { recursive: true })
    return { kind: i ? 'codex' : 'claude', memoryFile: join(directory, i ? 'AGENTS.md' : 'CLAUDE.md'), ruleFile: join(directory, 'rules', 'persistent-memory.md'), ruleRef: '@rules/persistent-memory.md' }
  })
  return { base, targets, first: targets[0]!, second: targets[1]! }
}
function write(path: string, content: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function backupNames(target: RuleTarget) { return readdirSync(dirname(target.memoryFile)).filter(name => name.includes('.persistent-memory-backup-')) }
afterEach(() => {
  faults.backupPrefix = ''
  vi.restoreAllMocks()
  for (const base of fixtures.splice(0)) {
    const owned = relative(resolve(tmpdir()), resolve(base))
    expect(owned && !owned.startsWith('..') && !isAbsolute(owned)).toBeTruthy()
    rmSync(base, { recursive: true, force: true })
  }
})

describe('safe recovery of existing memory instruction files', () => {
  it.each([
    `${BEGIN}\nKeep private fixture guidance.\n`,
    `Keep private fixture guidance.\n${END}\n`,
    `${BEGIN}\n${BEGIN}\nKeep private fixture guidance.\n${END}\n`,
  ])('backs up damaged instructions byte-for-byte and reports their location: %s', original => {
    const { first } = fixture()
    const bytes = Buffer.from(`\uFEFF# Équipe 项目\r\n\r\n${original.replace(/\n/g, '\r\n')}\r\n`)
    write(first.memoryFile, bytes)
    const result = writeRuleTargets([first], '# New detailed protocol')
    expect(result.writtenTargets).toBe(1)
    expect(result.repairs).toHaveLength(1)
    const repair = result.repairs[0]!
    expect(repair.memoryFile).toBe(first.memoryFile)
    expect(repair.backupFile.startsWith(`${first.memoryFile}.persistent-memory-backup-`)).toBe(true)
    expect(readFileSync(repair.backupFile)).toEqual(bytes)
    const installed = readFileSync(first.memoryFile, 'utf8')
    const preserved = bytes.toString('utf8').slice(1).replaceAll(BEGIN, '<!-- persistent-memory:recovered-begin -->').replaceAll(END, '<!-- persistent-memory:recovered-end -->')
    expect(installed.startsWith(`\uFEFF${BEGIN}\r\n`)).toBe(true)
    expect(installed.endsWith(preserved)).toBe(true)
    expect(readFileSync(first.ruleFile, 'utf8')).toBe('# New detailed protocol\n')
    expect(ruleRepairWarning(repair)).toContain('WARN:')
    expect(ruleRepairWarning(repair)).toContain(first.memoryFile)
    expect(ruleRepairWarning(repair)).toContain(repair.backupFile)
    expect(ruleRepairWarning(repair)).not.toContain('private fixture guidance')
    expect(writeRuleTargets([first], '# New detailed protocol').repairs).toEqual([])
    expect(readFileSync(first.memoryFile, 'utf8')).toBe(installed)
    expect(backupNames(first)).toHaveLength(1)
    expect(readFileSync(repair.backupFile)).toEqual(bytes)
  })

  it('never overwrites an earlier backup when repair timestamps collide', () => {
    const { first } = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(123456789)
    const before = `${BEGIN}\nFirst original.\n`
    const later = `${END}\nSecond original.\n`
    write(first.memoryFile, before)
    const firstBackup = writeRuleTargets([first], '# Rule').repairs[0]!.backupFile
    write(first.memoryFile, later)
    const secondBackup = writeRuleTargets([first], '# Rule').repairs[0]!.backupFile
    expect(firstBackup).toBe(`${first.memoryFile}.persistent-memory-backup-123456789.bak`)
    expect(secondBackup).toBe(`${first.memoryFile}.persistent-memory-backup-123456789-1.bak`)
    expect(readFileSync(firstBackup, 'utf8')).toBe(before)
    expect(readFileSync(secondBackup, 'utf8')).toBe(later)
  })

  it('leaves every instruction and detailed rule unchanged when a later backup fails', () => {
    const { targets, first, second } = fixture()
    const original = `${BEGIN}\nKeep the original.\n`
    for (const target of targets) { write(target.memoryFile, original); write(target.ruleFile, '# Existing rule\n') }
    faults.backupPrefix = `${second.memoryFile}.persistent-memory-backup-`
    expect(() => writeRuleTargets(targets, '# Replacement rule')).toThrow('instruction and rule files were not changed')
    for (const target of targets) {
      expect(readFileSync(target.memoryFile, 'utf8')).toBe(original)
      expect(readFileSync(target.ruleFile, 'utf8')).toBe('# Existing rule\n')
    }
    expect(backupNames(first)).toHaveLength(1)
    expect(readFileSync(join(dirname(first.memoryFile), backupNames(first)[0]!), 'utf8')).toBe(original)
    expect(backupNames(second)).toEqual([])
  })

  it('fails without overwriting backups after a bounded number of filename collisions', () => {
    const { first } = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(42)
    write(first.memoryFile, `${BEGIN}\nPreserve this.\n`)
    for (let i = 0; i < 100; i++) write(`${first.memoryFile}.persistent-memory-backup-42${i ? `-${i}` : ''}.bak`, `Existing backup ${i}`)
    expect(() => writeRuleTargets([first], '# Rule')).toThrow('Existing backups were preserved')
    expect(readFileSync(first.memoryFile, 'utf8')).toBe(`${BEGIN}\nPreserve this.\n`)
    expect(existsSync(first.ruleFile)).toBe(false)
    expect(backupNames(first)).toHaveLength(100)
    for (let i = 0; i < 100; i++) expect(readFileSync(`${first.memoryFile}.persistent-memory-backup-42${i ? `-${i}` : ''}.bak`, 'utf8')).toBe(`Existing backup ${i}`)
  })

  it.each([BEGIN, END, `${BEGIN}\n${END}`, `${END}\nEscaped region\n${BEGIN}`, '```markdown\nUnclosed fence'])('rejects invalid custom blocks before any backup or write: %s', custom => {
    const { targets } = fixture()
    for (const target of targets) { write(target.memoryFile, `${BEGIN}\nOriginal.\n`); write(target.ruleFile, '# Existing rule\n') }
    expect(() => writeRuleTargets(targets, '# Replacement rule', custom)).toThrow(/markers/)
    for (const target of targets) {
      expect(readFileSync(target.memoryFile, 'utf8')).toBe(`${BEGIN}\nOriginal.\n`)
      expect(readFileSync(target.ruleFile, 'utf8')).toBe('# Existing rule\n')
      expect(backupNames(target)).toEqual([])
    }
  })

  it('preflights all originals and rejects invalid UTF-8 without replacing bytes or writing any target', () => {
    const { targets, first, second } = fixture()
    const valid = Buffer.from(`${BEGIN}\nPreserve first target.\n`)
    const invalid = Buffer.concat([Buffer.from(`${BEGIN}\nPreserve second target: `), Buffer.from([0xc3, 0x28])])
    write(first.memoryFile, valid)
    write(second.memoryFile, invalid)
    expect(() => writeRuleTargets(targets, '# Rule')).toThrow(`Could not read ${second.memoryFile} as UTF-8`)
    expect(readFileSync(first.memoryFile)).toEqual(valid)
    expect(readFileSync(second.memoryFile)).toEqual(invalid)
    for (const target of targets) { expect(backupNames(target)).toEqual([]); expect(existsSync(target.ruleFile)).toBe(false) }
  })

  it('surfaces the backup path if creating the detailed-rule directory fails after backup', () => {
    const { first } = fixture()
    const original = `${BEGIN}\nOriginal instructions.\n`
    write(first.memoryFile, original)
    write(dirname(first.ruleFile), 'File that cannot become a directory')
    let failure = ''
    try { writeRuleTargets([first], '# Rule') } catch (error) { failure = (error as Error).message }
    expect(failure).toContain('Could not write repaired instructions')
    expect(failure).toContain(join(dirname(first.memoryFile), backupNames(first)[0]!))
    expect(readFileSync(first.memoryFile, 'utf8')).toBe(original)
    expect(readFileSync(dirname(first.ruleFile), 'utf8')).toBe('File that cannot become a directory')
  })

  it('does not back up ordinary valid instructions or fenced marker examples', () => {
    const { first } = fixture()
    const examples = `\`\`\`markdown\n${BEGIN}\n\`\`\`\n\n    ${END}\n`
    write(first.memoryFile, `# Existing\n\n${BEGIN}\nOld generated block.\n${END}\n\n${examples}`)
    expect(writeRuleTargets([first], '# Rule').repairs).toEqual([])
    expect(backupNames(first)).toEqual([])
    expect(readFileSync(first.memoryFile, 'utf8')).toContain(examples)
    expect(readFileSync(first.memoryFile, 'utf8')).not.toContain('Old generated block.')
  })
})
