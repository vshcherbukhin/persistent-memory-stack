/**
 * persistent-memory — LIVE integration suite: the tiny HTTP client.
 *
 * A thin wrapper over global `fetch` (Node 18+/undici — already available, no
 * dependency). Every call targets the running api at PM_API_BASE (default
 * http://localhost:8090) and returns a plain `{ status, json }` so the specs can
 * assert on both without try/catch noise. Auth is `Authorization: Bearer
 * <tokenId>.<secret>` — the wire-token format the api's deriveIdentity expects
 * (api/src/auth/authenticate.ts).
 *
 * Also exports:
 *   • `apiMultipart` — multipart/form-data POST for /ingest (the only multipart
 *     route; the api reads the part named "file" plus best-effort string fields).
 *   • `poll` — re-invoke an async fn until a predicate holds or a deadline passes
 *     (for the async ingest job that transitions queued → … → completed).
 */

export const API_BASE = process.env.PM_API_BASE ?? 'http://localhost:8090'

export interface ApiResponse<T = unknown> {
  status: number
  json: T
}

export interface ApiOptions {
  /** Wire token `${tokenId}.${secret}`. Omit for the unauthenticated surface. */
  token?: string
  /** JSON body — serialized + sent as application/json. */
  body?: unknown
  /** Extra query params appended to the path. */
  query?: Record<string, string | number | boolean | undefined>
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

function buildUrl(path: string, query?: ApiOptions['query']): string {
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

/**
 * Issue a JSON request and return `{ status, json }`. A non-JSON / empty body
 * (e.g. a 204) parses to `null`. Never throws on a non-2xx — the caller asserts
 * on `status`.
 */
export async function api<T = unknown>(
  method: HttpMethod,
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(buildUrl(path, opts.query), { method, headers, body })
  return { status: res.status, json: (await safeJson(res)) as T }
}

/**
 * Multipart upload for POST /ingest. `fields` become string form fields
 * (project/title/sessionId — all optional, best-effort on the server side); the
 * file part is named "file" exactly as the api expects (req.file()).
 */
export async function apiMultipart<T = unknown>(
  path: string,
  opts: {
    token: string
    filename: string
    /** File body — string only (these tests upload text files). */
    content: string
    contentType?: string
    fields?: Record<string, string>
  },
): Promise<ApiResponse<T>> {
  const form = new FormData()
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v)
  const blob = new Blob([opts.content], { type: opts.contentType ?? 'text/plain' })
  // The api reads the FIRST file part via req.file(); the field name must be "file".
  form.append('file', blob, opts.filename)
  const res = await fetch(buildUrl(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  })
  return { status: res.status, json: (await safeJson(res)) as T }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Poll `fn` until `predicate(result)` is true or the deadline elapses. Returns
 * the last result. Used for the async ingest job (queued → completed/failed).
 */
export async function poll<T>(
  fn: () => Promise<T>,
  predicate: (r: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const intervalMs = opts.intervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs
  let last = await fn()
  while (!predicate(last)) {
    if (Date.now() >= deadline) return last
    await sleep(intervalMs)
    last = await fn()
  }
  return last
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
