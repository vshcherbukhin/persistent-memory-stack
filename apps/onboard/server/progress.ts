import { StringDecoder } from 'node:string_decoder'

export type PrereqProgressStage = 'download' | 'verify' | 'install' | 'start' | 'ready'

export interface PrereqProgress {
  stage: PrereqProgressStage
  downloadedBytes?: number
  totalBytes?: number
}

export type PrereqOutputEvent =
  | ({ type: 'progress'; id: string } & PrereqProgress)
  | { type: 'stdout'; id: string; chunk: string }

const PREFIX = 'PM_OLLAMA_PROGRESS '
const MAX_RECORD_LENGTH = 16 * 1024
const STAGES: readonly string[] = ['download', 'verify', 'install', 'start', 'ready']

function parseProgress(line: string): PrereqProgress | null {
  if (!line.startsWith(PREFIX) || line.length > MAX_RECORD_LENGTH) return null
  try {
    const value: unknown = JSON.parse(line.slice(PREFIX.length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.stage !== 'string' || !STAGES.includes(record.stage)) return null
    const result: PrereqProgress = { stage: record.stage as PrereqProgressStage }
    for (const key of ['downloadedBytes', 'totalBytes'] as const) {
      if (record[key] === undefined) continue
      if (record.stage !== 'download' || !Number.isSafeInteger(record[key]) ||
          (record[key] as number) < (key === 'totalBytes' ? 1 : 0)) return null
      result[key] = record[key] as number
    }
    if (result.totalBytes !== undefined && result.downloadedBytes !== undefined &&
        result.downloadedBytes > result.totalBytes) return null
    return result
  } catch { return null }
}

/** Decode one child output pipe. Never mix partial stdout and stderr records. */
export function createPrereqOutputParser(id: string, emit: (event: PrereqOutputEvent) => void): {
  write: (chunk: Buffer) => void
  end: () => void
} {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let passthrough = false
  let ended = false
  const stdout = (chunk: string): void => { if (chunk) emit({ type: 'stdout', id, chunk }) }
  const line = (text: string): void => {
    const progress = parseProgress(text.replace(/\r?\n$/, ''))
    if (progress) emit({ type: 'progress', id, ...progress })
    else stdout(text)
  }
  const drain = (): void => {
    while (pending) {
      const newline = pending.indexOf('\n')
      if (newline !== -1) {
        const complete = pending.slice(0, newline + 1)
        if (passthrough) stdout(complete)
        else line(complete)
        pending = pending.slice(newline + 1)
        passthrough = false
      } else if (passthrough || pending.length > MAX_RECORD_LENGTH ||
                 (!PREFIX.startsWith(pending) && !pending.startsWith(PREFIX))) {
        // Ordinary output remains live even when a tool uses carriage returns
        // instead of newlines. A broken/oversized progress record cannot grow
        // the buffer indefinitely or turn a mid-line prefix into a record.
        stdout(pending)
        pending = ''
        passthrough = true
      } else return
    }
  }
  return {
    write(chunk): void {
      if (ended) return
      pending += decoder.write(chunk)
      drain()
    },
    end(): void {
      if (ended) return
      ended = true
      pending += decoder.end()
      drain()
      if (pending) {
        if (passthrough) stdout(pending)
        else line(pending)
        pending = ''
      }
    },
  }
}
