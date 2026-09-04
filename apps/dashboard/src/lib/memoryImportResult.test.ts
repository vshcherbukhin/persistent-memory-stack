import { describe, expect, it } from 'vitest'
import { memoryImportNotice } from './memoryImportResult'

describe('memoryImportNotice', () => {
  it('treats an all-error import as an error, not a success', () => {
    expect(memoryImportNotice({ imported: 0, embedded: 0, pending: 0, errors: 28, details: [] })).toEqual({
      kind: 'error',
      text: 'Import failed: 0 imported, 28 errors.',
    })
  })

  it('warns when only part of the import failed', () => {
    expect(memoryImportNotice({ imported: 20, embedded: 0, pending: 20, errors: 8, details: [] })).toEqual({
      kind: 'warn',
      text: 'Imported 20 (0 embedded, 20 pending, 8 errors).',
    })
  })

  it('reports a clean import as success', () => {
    expect(memoryImportNotice({ imported: 27, embedded: 3, pending: 24, errors: 0, details: [] })).toEqual({
      kind: 'success',
      text: 'Imported 27 (3 embedded, 24 pending, 0 errors).',
    })
  })
})
