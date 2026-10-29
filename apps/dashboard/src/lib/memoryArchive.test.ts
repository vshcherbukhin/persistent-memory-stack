import { describe, expect, it } from 'vitest'
import { decryptMemoryArchive, encryptMemoryArchive, readMemoryArchive } from './memoryArchive'

const row = {
  id: '10000000-0000-4000-8000-000000000001', content: 'Synthetic source-reported knowledge retained across an archive round trip.',
  project: 'synthetic-project', category: 'legacy', shape: 'atomic', entities: [], revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z', recordUpdatedAt: '2026-01-03T00:00:00.000Z',
  classification: null, metadata: { originalSource: 'synthetic-tool-result' },
  revisionHistory: [{ revision: 1, content: 'Original synthetic claim.', evidence: [{ reference: 'tool:fixture' }] }],
}
const archive = { schema: 'pm.memory-export/2', count: 1, exportedAt: '2026-01-04T00:00:00.000Z', memories: [row] }

describe('versioned memory archives', () => {
  it('preserves exact content, stable IDs, timestamps, metadata, revision and history through encrypted .pm', async () => {
    const encrypted = await encryptMemoryArchive(archive, 'synthetic-long-passphrase')
    expect(encrypted.schema).toBe('pm.secure-memory-export/1')
    expect(JSON.stringify(encrypted)).not.toContain(row.content)
    const restored = await decryptMemoryArchive(encrypted, 'synthetic-long-passphrase')
    expect(restored).toEqual(archive)
    expect(readMemoryArchive(restored).memories).toEqual([row])
    await expect(decryptMemoryArchive(encrypted, 'wrong-passphrase')).rejects.toBeDefined()
  })
  it('retains explicit supported legacy readers without accepting an unknown envelope', () => {
    expect(readMemoryArchive([row])).toMatchObject({ schema: 'pm.memory-export/1', legacyArray: true, memories: [row] })
    expect(readMemoryArchive({ schema: 'pm.memory-export/1', count: 1, memories: [row] }).schema).toBe('pm.memory-export/1')
    expect(() => readMemoryArchive({ schema: 'future-unknown/9', memories: [row] })).toThrow('Unsupported memory archive')
  })
  it('rejects count mismatches and version 2 rows that lost revision history', () => {
    expect(() => readMemoryArchive({ ...archive, count: 2 })).toThrow('count does not match')
    const { revisionHistory: _history, ...damaged } = row
    expect(() => readMemoryArchive({ ...archive, memories: [damaged] })).toThrow('missing its revision, classification or history')
  })
  it('bounds unsupported encryption work before invoking the key derivation', async () => {
    const encrypted = await encryptMemoryArchive(archive, 'synthetic-passphrase')
    await expect(decryptMemoryArchive({ ...encrypted, crypto: { ...encrypted.crypto, iterations: 1_000_000_000 } }, 'synthetic-passphrase')).rejects.toThrow('Unsupported secure archive encryption parameters')
  })
})
