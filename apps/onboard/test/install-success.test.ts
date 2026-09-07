import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeInstallSuccess } from '../server/install-success.js'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function directory() { const path = mkdtempSync(join(tmpdir(), 'pm success é 空 ')); temporary.push(path); return path }

describe('successful installation embedding marker', () => {
  it('writes only the verified selection and completion metadata, without credentials', () => {
    const root = directory()
    writeInstallSuccess(root, { EMBED_PROVIDER: 'openai', EMBED_MODEL: 'text-embedding-3-small', EMBED_DIM: '1536', OPENAI_API_KEY: 'synthetic-fixture-do-not-copy', DATABASE_URL: 'synthetic-private-database-url' })
    const target = join(root, '.local/install-artifacts')
    const marker = JSON.parse(readFileSync(join(target, 'success.json'), 'utf8'))
    expect(marker).toEqual({ version: 1, finishedAt: expect.any(String), embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 } })
    expect(readdirSync(target)).toEqual(['success.json'])
  })
  it('does not replace the previous successful marker when the new selection is invalid', () => {
    const root = directory()
    writeInstallSuccess(root, { EMBED_PROVIDER: 'ollama', EMBED_MODEL: 'nomic-embed-text', EMBED_DIM: '768' })
    const marker = join(root, '.local/install-artifacts/success.json')
    const before = readFileSync(marker)
    expect(() => writeInstallSuccess(root, { EMBED_PROVIDER: 'openai', EMBED_MODEL: 'text-embedding-3-small', EMBED_DIM: 'NaN' })).toThrow(/invalid/)
    expect(readFileSync(marker)).toEqual(before)
  })
})
