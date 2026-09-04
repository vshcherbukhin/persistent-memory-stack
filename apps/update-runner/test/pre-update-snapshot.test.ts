import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('pre-update snapshot', () => {
  it('uses the repository Compose file for its service inventory and PostgreSQL dump', async () => {
    const source = await readFile(new URL('../../../scripts/pre-update-snapshot.mjs', import.meta.url), 'utf8')

    expect(source).toContain("'compose', '-f', join(repoRoot, 'deploy', 'compose', 'docker-compose.yml'), '--env-file', envPath")
  })
})
