interface NdjsonReply {
  hijack(): unknown
  raw: {
    readonly destroyed?: boolean
    readonly writableEnded?: boolean
    on(event: 'close' | 'error', listener: () => void): unknown
    writeHead(status: number, headers: Record<string, string>): unknown
    write(chunk: string): unknown
    end(): unknown
  }
}

/** A disconnected browser stops receiving output; it does not cancel host work. */
export function createNdjsonStream(reply: NdjsonReply): {
  emit: (event: unknown) => void
  end: () => void
} {
  reply.hijack()
  const response = reply.raw
  let closed = false
  const close = (): void => { closed = true }
  const unavailable = (): boolean => closed || !!response.destroyed || !!response.writableEnded
  // Stream errors are emitted asynchronously, outside the route's try/catch.
  // Keep the listener for the response lifetime, including late socket errors.
  response.on('error', close)
  response.on('close', close)
  if (!unavailable()) {
    try {
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    } catch { close() }
  }
  return {
    emit(event): void {
      if (unavailable()) return
      try { response.write(JSON.stringify(event) + '\n') } catch { close() }
    },
    end(): void {
      if (unavailable()) return
      close()
      try { response.end() } catch { /* The client may disconnect before end. */ }
    },
  }
}
