import type { MemoryImportResult } from './types'

export type MemoryImportNotice = {
  kind: 'success' | 'warn' | 'error'
  text: string
}

export function memoryImportNotice(result: MemoryImportResult): MemoryImportNotice {
  const detail = `${result.imported.toLocaleString()} (${result.embedded.toLocaleString()} embedded, ${result.pending.toLocaleString()} pending, ${result.errors.toLocaleString()} errors).`
  if (result.imported === 0 && result.errors > 0) {
    return { kind: 'error', text: `Import failed: ${result.imported.toLocaleString()} imported, ${result.errors.toLocaleString()} errors.` }
  }
  if (result.errors > 0) return { kind: 'warn', text: `Imported ${detail}` }
  return { kind: 'success', text: `Imported ${detail}` }
}
