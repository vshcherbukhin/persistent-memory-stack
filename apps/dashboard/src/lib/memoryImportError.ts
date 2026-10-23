/** Preserve actionable transport causes in a serializable Server Action response. */
export function memoryImportTransportError(error: unknown): string {
  const codes: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const cause = current as { code?: unknown; cause?: unknown }
    if (typeof cause.code === 'string') codes.push(cause.code)
    current = cause.cause
  }
  if (codes.some((code) => /TIMEOUT|TIMEDOUT/.test(code)) || (error instanceof Error && error.name === 'TimeoutError')) {
    return `The server response timed out${codes.length ? ` (${codes.join(', ')})` : ''}. The current row may still be processing on the server. Check the memory list before resuming.`
  }
  const message = error instanceof Error ? error.message : 'The import connection was interrupted.'
  return `${message}${codes.length ? ` (${codes.join(', ')})` : ''}. The current row's outcome is unknown; check the memory list before resuming.`
}
