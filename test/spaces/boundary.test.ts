import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

const spaceCases = [
  ['local-personal', 'Local Personal'],
  ['local-shared-client', 'Local Shared Client'],
  ['shared-server', 'Shared Server'],
] as const

describe('space boundaries', () => {
  it.each(spaceCases)('keeps the %s space skeleton in place', (space, title) => {
    const dir = `${root}/spaces/${space}`
    const readmePath = `${dir}/README.md`

    expect(existsSync(dir), `${space} space directory should exist`).toBe(true)
    expect(existsSync(readmePath), `${space} space README should exist`).toBe(true)

    const readme = readFileSync(readmePath, 'utf8')
    expect(readme.startsWith(`# ${title}`), `${space} space README title should match`).toBe(true)
    expect(readme, `${space} space README should point to its verification path`).toContain(
      `test/spaces/${space}/`,
    )
  })

  it('keeps deployment-space names separate from app-shell names', () => {
    expect(existsSync(`${root}/spaces/admin`)).toBe(false)
    expect(existsSync(`${root}/spaces/api`)).toBe(false)
  })
})
