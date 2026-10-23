import type { MemoryImportResult } from './types'

export type MemoryImportProgress = { completed: number; result: MemoryImportResult }
export type MemoryImportRun = MemoryImportProgress & { interrupted?: { index: number; message: string; rejected?: boolean } }

export class MemoryImportRequestError extends Error {
  constructor(message: string, readonly rejected: boolean) { super(message) }
}

export const emptyMemoryImportResult = (): MemoryImportResult => ({ imported: 0, embedded: 0, pending: 0, errors: 0, details: [] })

/** One row per request bounds embedding latency and acknowledges each durable result. Never retry an unknown outcome automatically. */
export async function runMemoryImport(
  memories: unknown[],
  importRow: (rows: unknown[]) => Promise<MemoryImportResult>,
  onProgress: (progress: MemoryImportProgress) => void,
  previous: MemoryImportProgress = { completed: 0, result: emptyMemoryImportResult() },
): Promise<MemoryImportRun> {
  let result = previous.result
  for (let index = previous.completed; index < memories.length; index += 1) {
    let row: MemoryImportResult
    try {
      row = await importRow([memories[index]])
    } catch (error) {
      return { completed: index, result, interrupted: { index: index + 1, message: error instanceof Error ? error.message : String(error), ...(error instanceof MemoryImportRequestError ? { rejected: error.rejected } : {}) } }
    }
    result = {
      imported: result.imported + row.imported,
      embedded: result.embedded + row.embedded,
      pending: result.pending + row.pending,
      errors: result.errors + row.errors,
      details: [...result.details, ...row.details.map((detail) => ({ ...detail, index: index + detail.index }))].slice(0, 100),
    }
    onProgress({ completed: index + 1, result })
  }
  return { completed: memories.length, result }
}
