/** Thin fetch + NDJSON-stream client to the local onboarding server. */

const CONNECTION_ERROR = 'The installer connection was lost. Check its terminal. If it has stopped, restart it, then choose Check again.'

async function localFetch(url: string, options?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, options)
  } catch {
    throw new Error(CONNECTION_ERROR)
  }
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await localFetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json() as Promise<T>
}

export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await localFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json() as Promise<T>
}

/** POST a body, then read the NDJSON response line-by-line, one parsed event at a time. */
export async function streamNDJSON(
  url: string,
  body: unknown,
  onEvent: (e: Record<string, unknown>) => void,
): Promise<void> {
  const res = await localFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const payload: unknown = await res.json().catch(() => null)
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : `${url} → ${res.status}`
    throw new Error(message)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('The installer returned no progress stream. Check its state before retrying.')
  const dec = new TextDecoder()
  let buf = ''
  let completed = false
  let failure: string | undefined
  const deliver = (line: string) => {
    if (!line.trim()) return
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      event = parsed as Record<string, unknown>
    } catch { return /* Ignore non-JSON diagnostic lines. */ }
    if (event.type === 'error' && typeof event.message === 'string') failure = event.message
    if (event.type === 'done') {
      completed = true
      if (event.ok === false) failure ??= 'The installer reported a failure. Review the log before retrying.'
    }
    onEvent(event)
  }
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() } catch { throw new Error(CONNECTION_ERROR) }
      if (chunk.done) break
      buf += dec.decode(chunk.value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        deliver(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
    deliver(buf + dec.decode())
  } finally {
    reader.releaseLock()
  }
  if (!completed) throw new Error('The installer connection ended before completion was confirmed. Check its state before retrying.')
  if (failure) throw new Error(failure)
}
