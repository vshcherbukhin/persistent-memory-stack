import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../../', import.meta.url)
const releaseContract = new URL('../../../release/upgrade.json', import.meta.url)
const releaseSchema = new URL('../../../schemas/release-upgrade.schema.json', import.meta.url)
const releaseValidator = new URL('../../../scripts/validate-release-upgrade.mjs', import.meta.url)

function nextPatch(version: string): string {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) throw new Error(`invalid release version: ${version}`)
  const [major, minor, patch] = parts as [number, number, number]
  return `${major}.${minor}.${patch + 1}`
}

describe('release upgrade contract', () => {
  it('ships a machine-readable bootstrap contract for the current release', () => {
    expect(existsSync(releaseContract)).toBe(true)

    const contract = JSON.parse(readFileSync(releaseContract, 'utf8')) as Record<string, unknown>
    const rootPackage = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string }

    expect(contract).toMatchObject({
      schemaVersion: 1,
      release: rootPackage.version,
      minimumSupportedSource: '4.0.24',
      compatibleMajorLine: 4,
      directFrom: `>=4.0.24 <${nextPatch(rootPackage.version)}`,
      coordinator: { minimumVersion: 1, bootstrap: true },
    })
  })

  it('publishes the schema used to validate release contracts', () => {
    expect(existsSync(releaseSchema)).toBe(true)

    const schema = JSON.parse(readFileSync(releaseSchema, 'utf8')) as Record<string, unknown>
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Persistent Memory release upgrade contract',
      type: 'object',
    })
    expect(schema.required).toEqual(expect.arrayContaining([
      'schemaVersion',
      'release',
      'minimumSupportedSource',
      'compatibleMajorLine',
      'directFrom',
      'bridges',
      'requiredStops',
      'coordinator',
    ]))
  })

  // This test intentionally compiles the checked-out updater before validation.
  // The default Vitest 5s budget flakes on a cold TypeScript cache.
  it('validates the checked-out release contract through the compiled release validator', () => {
    expect(() => execFileSync('npm', ['run', 'validate:release-upgrade'], {
      cwd: new URL('../../../', import.meta.url),
      stdio: 'pipe',
    })).not.toThrow()
  }, 20_000)

  it('discovers prior contracts from the trusted release ref only', () => {
    const source = readFileSync(releaseValidator, 'utf8')

    expect(source).toContain("const trustedReleaseRef = 'origin/master'")
    expect(source).not.toContain("'--all'")
  })
})
