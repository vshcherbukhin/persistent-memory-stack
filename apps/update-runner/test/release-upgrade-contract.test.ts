import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostCommand } from '../../onboard/server/host.ts'

const root = new URL('../../../', import.meta.url)
const releaseContract = new URL('../../../release/upgrade.json', import.meta.url)
const releaseSchema = new URL('../../../schemas/release-upgrade.schema.json', import.meta.url)
const releaseValidator = new URL('../../../scripts/validate-release-upgrade.mjs', import.meta.url)

describe('release upgrade contract', () => {
  it('ships a machine-readable bootstrap contract for the current release', () => {
    expect(existsSync(releaseContract)).toBe(true)

    const contract = JSON.parse(readFileSync(releaseContract, 'utf8')) as Record<string, unknown>
    const rootPackage = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string }

    expect(contract).toMatchObject({
      schemaVersion: 1,
      release: rootPackage.version,
      minimumSupportedSource: '1.0.0',
      compatibleMajorLine: 1,
      directFrom: '=1.0.0',
      bridges: [],
      requiredStops: [],
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
    const command = hostCommand('npm', ['run', 'validate:release-upgrade'])
    expect(() => execFileSync(command.command, command.args, {
      cwd: new URL('../../../', import.meta.url),
      env: command.env,
      windowsHide: true,
      stdio: 'pipe',
    })).not.toThrow()
  }, 20_000)

  it('discovers prior contracts from the trusted release ref only', () => {
    const source = readFileSync(releaseValidator, 'utf8')

    expect(source).toContain("const trustedReleaseRef = 'origin/master'")
    expect(source).not.toContain("'--all'")
  })
})
