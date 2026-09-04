/**
 * The typed persistent-memory-api client — the ONLY place PM_USER_TOKEN is used.
 *
 *   • Token-authenticated requests attach `Authorization: Bearer ${PM_USER_TOKEN}`.
 *   • The token is injected as a header ONLY — never into a URL, never logged.
 *   • Non-2xx → throws ApiError (mapped to actionable agent text in errors.ts).
 *   • A fetch throw (network/DNS/abort) → ApiError.transport.
 *   • Logs request method+path+status to STDERR only; never headers/body/URL.
 *
 * The MCP itself does ZERO auth/RLS — the API is the choke-point. This client is
 * a thin Bearer-attaching pass-through.
 */
import { log, redactToken } from './log.ts'
import { ApiError } from './errors.ts'
import type { McpConfig } from './config.ts'
import { currentMcpRequestContext } from './request-context.ts'

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v }
  } catch {
    return undefined
  }
}

export class ApiClient {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(cfg: Pick<McpConfig, 'API_URL' | 'PM_USER_TOKEN' | 'PM_API_TIMEOUT_MS'>) {
    this.base = cfg.API_URL.replace(/\/$/, '')
    this.token = cfg.PM_USER_TOKEN ?? ''
    this.timeoutMs = cfg.PM_API_TIMEOUT_MS
  }

  /** Build a URL with an optional querystring (skips undefined/null values). */
  private url(path: string, query?: Record<string, unknown>): string {
    if (!query) return `${this.base}${path}`
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) {
        for (const item of v) usp.append(k, String(item))
      } else {
        usp.append(k, String(v))
      }
    }
    const qs = usp.toString()
    return qs ? `${this.base}${path}?${qs}` : `${this.base}${path}`
  }

  private async req<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, unknown>; form?: FormData } = {},
  ): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    const url = this.url(path, opts.query)

    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.token) headers.authorization = `Bearer ${this.token}` // ← the ONLY use of the token
    let payload: FormData | string | undefined
    if (opts.form) {
      // Multipart — let fetch set content-type + boundary; do NOT set it manually.
      payload = opts.form
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(opts.body)
    }

    let res: Response
    try {
      res = await fetch(url, { method, headers, body: payload, signal: ctrl.signal })
    } catch (e) {
      throw ApiError.transport(method, path, this.base, e)
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    const json = text ? safeJson(text) : undefined
    // STDERR only — path is redacted defensively; headers/body NEVER logged.
    log.info('api', {
      ...currentMcpRequestContext(),
      method,
      path: redactToken(path),
      status: res.status,
    })
    if (!res.ok) throw ApiError.fromResponse(res.status, json, this.base)
    return (json ?? ({} as Record<string, unknown>)) as T
  }

  get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.req<T>('GET', path, { query })
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.req<T>('POST', path, { body })
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.req<T>('PATCH', path, { body })
  }
  /** DELETE with an optional JSON body (delete_all_memories sends {confirm}). */
  del<T>(path: string, body?: unknown): Promise<T> {
    return this.req<T>('DELETE', path, { body })
  }
  /** DELETE with no body that yields a 204 (delete_memory) — normalized to {}. */
  delNoContent(path: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>('DELETE', path, {})
  }
  postForm<T>(path: string, form: FormData): Promise<T> {
    return this.req<T>('POST', path, { form })
  }

  registerMcpSession(body: {
    id: string
    clientName: string
    connectionType: 'stream' | 'stdio'
    pid?: number
    terminateSupported?: boolean
    lastActivityAt?: string
  }): Promise<{ ok: true }> {
    return this.post<{ ok: true }>('/mcp-sessions', body)
  }

  heartbeatMcpSession(id: string, body?: { lastActivityAt?: string }): Promise<{ terminate: boolean; registered?: boolean }> {
    return this.post<{ terminate: boolean; registered?: boolean }>(`/mcp-sessions/${encodeURIComponent(id)}/heartbeat`, body)
  }

  closeMcpSession(id: string): Promise<{ ok: true }> {
    return this.del<{ ok: true }>(`/mcp-sessions/${encodeURIComponent(id)}`)
  }
}
