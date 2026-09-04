export type LogLevel = 'info' | 'warn' | 'error'
export type LogTimeMode = 'local' | 'server'

export interface FormattedLogEntry {
  timestamp: Date | null
  level: LogLevel
  message: string
}

export interface ParseLogOptions {
  fallback?: string
  fallbackLevel?: LogLevel
  fallbackTimestamp?: string | null
  maxLines?: number
}

const DOCKER_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2}))\s+(.*)$/
const LOCAL_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?\s+(.*)$/
const LEVEL_PREFIX_RE = /^\[?(INFO|WARN|WARNING|ERROR|ERR|FATAL)\]?:?\s*(.*)$/i
const JAVASCRIPT_ERROR_PREFIX_RE = /^(?:[×x]\s*)?(?:[A-Z][\w]*Error|Error)(?:\s+\[[^\]\r\n]+\])?:/i
const PROPERTY_CONTINUATION_RE = /^(?:\[?[A-Za-z_$][\w$.[\]-]*\]?)\s*[:=]/

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function normalizeTimestamp(value: string): string {
  return value
    .replace(/\.(\d{1,9})(Z|[+-]\d{2}:?\d{2})$/, (_whole, fraction: string, zone: string) => {
      const normalizedZone = zone === 'Z' || zone.includes(':')
        ? zone
        : `${zone.slice(0, 3)}:${zone.slice(3)}`
      return `.${fraction.padEnd(3, '0').slice(0, 3)}${normalizedZone}`
    })
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = Date.parse(normalizeTimestamp(value))
  return Number.isFinite(parsed) ? new Date(parsed) : null
}

function pinoLevel(value: unknown, fallback: LogLevel): LogLevel {
  if (typeof value === 'number') {
    if (value >= 50) return 'error'
    if (value >= 40) return 'warn'
    return 'info'
  }
  if (typeof value === 'string') return inferLevel(value, fallback)
  return fallback
}

function inferLevel(line: string, fallback: LogLevel): LogLevel {
  const prefix = line.match(LEVEL_PREFIX_RE)?.[1]?.toLowerCase()
  if (prefix === 'error' || prefix === 'err' || prefix === 'fatal') return 'error'
  if (prefix === 'warn' || prefix === 'warning') return 'warn'
  if (/^\[?error[:\]]/i.test(line) || /^error:/i.test(line)) return 'error'
  if (/^\[?warn(?:ing)?[:\]]/i.test(line)) return 'warn'
  if (JAVASCRIPT_ERROR_PREFIX_RE.test(line.trim())) return 'error'
  if (/\b(?:ECONNREFUSED|EADDRINUSE|ETIMEDOUT|ENOTFOUND|ECONNRESET)\b/.test(line)) return 'error'
  return fallback
}

function stripLevelPrefix(line: string): string {
  const [firstLine = '', ...rest] = line.split('\n')
  const match = firstLine.match(LEVEL_PREFIX_RE)
  const firstMessage = (match?.[2] ?? firstLine).trimEnd()
  const message = [firstMessage, ...rest].join('\n').trim()
  return message || line.trim()
}

function jsonMessage(value: Record<string, unknown>, raw: string): string {
  const parts: string[] = []
  if (typeof value.msg === 'string' && value.msg.trim()) parts.push(value.msg.trim())
  if (typeof value.message === 'string' && value.message.trim() && value.message !== value.msg) {
    parts.push(value.message.trim())
  }

  const mcpRpcMethod = typeof value.mcpRpcMethod === 'string' ? value.mcpRpcMethod : null
  const mcpToolName = typeof value.mcpToolName === 'string' ? value.mcpToolName : null
  if (mcpRpcMethod) parts.push(mcpToolName ? `${mcpRpcMethod} ${mcpToolName}` : mcpRpcMethod)

  const topLevelMethod = typeof value.method === 'string' ? value.method : null
  const topLevelPath = typeof value.path === 'string'
    ? value.path
    : typeof value.url === 'string'
      ? value.url
      : null
  if (topLevelMethod && topLevelPath) parts.push(`${topLevelMethod} ${topLevelPath}`)

  const req = value.req
  if (req && typeof req === 'object') {
    const request = req as Record<string, unknown>
    const method = typeof request.method === 'string' ? request.method : null
    const url = typeof request.url === 'string' ? request.url : null
    if (method && url) parts.push(`${method} ${url}`)
  }

  const res = value.res
  if (res && typeof res === 'object') {
    const response = res as Record<string, unknown>
    if (typeof response.statusCode === 'number') parts.push(`status ${response.statusCode}`)
  }

  if (typeof value.status === 'number') parts.push(`status ${value.status}`)
  if (typeof value.responseTime === 'number') parts.push(`${value.responseTime.toFixed(1)}ms`)
  if (typeof value.durationMs === 'number') parts.push(`${value.durationMs}ms`)

  if (parts.length > 0) return parts.join(' | ')
  return raw
}

function parseJsonPayload(line: string, fallbackLevel: LogLevel): { level: LogLevel; message: string; timestamp: Date | null } | null {
  if (!line.trimStart().startsWith('{')) return null
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const row = parsed as Record<string, unknown>
    const level = pinoLevel(row.level, fallbackLevel)
    let timestamp: Date | null = null
    if (typeof row.time === 'number' && Number.isFinite(row.time)) timestamp = new Date(row.time)
    else if (typeof row.time === 'string') timestamp = parseDate(row.time)
    else if (typeof row.t === 'string') timestamp = parseDate(row.t)
    return { level, message: jsonMessage(row, line), timestamp }
  } catch {
    return null
  }
}

function splitTimestamp(line: string): { timestamp: Date | null; rest: string } {
  const docker = line.match(DOCKER_TIMESTAMP_RE)
  if (docker) return { timestamp: parseDate(docker[1]), rest: docker[2] ?? '' }

  const local = line.match(LOCAL_TIMESTAMP_RE)
  if (local) {
    const fraction = local[3] ? `.${local[3].padEnd(3, '0').slice(0, 3)}` : ''
    return { timestamp: parseDate(`${local[1]}T${local[2]}${fraction}Z`), rest: local[4] ?? '' }
  }

  return { timestamp: null, rest: line }
}

function braceDelta(payload: string): number {
  let delta = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  for (const char of payload) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '[') delta += 1
    if (char === '}' || char === ']') delta -= 1
  }
  return delta
}

function isContinuationPayload(payload: string): boolean {
  const trimmed = payload.trim()
  if (!trimmed) return true
  if (
    LEVEL_PREFIX_RE.test(trimmed) ||
    /^\[?error[:\]]/i.test(trimmed) ||
    /^\[?warn(?:ing)?[:\]]/i.test(trimmed) ||
    JAVASCRIPT_ERROR_PREFIX_RE.test(trimmed)
  ) {
    return false
  }
  return (
    /^[}\])]/.test(trimmed) ||
    /^(?:at\s+|Caused by:|\[cause\]:)/i.test(trimmed) ||
    PROPERTY_CONTINUATION_RE.test(trimmed) ||
    /^[,;]?$/.test(trimmed)
  )
}

function startsBlockPayload(payload: string): boolean {
  const trimmed = payload.trimStart()
  return trimmed === '{' || trimmed === '[' || trimmed.startsWith('{ ') || trimmed.startsWith('[ ')
}

function groupLogRecords(lines: string[]): string[] {
  const records: string[] = []
  let current: string[] = []
  let braceDepth = 0
  let currentTimestampMs: number | null = null

  for (const line of lines) {
    const { timestamp, rest } = splitTimestamp(line)
    const payload = rest.trim()
    const timestampMs = timestamp?.getTime() ?? null
    const sameTimestamp = timestampMs !== null && currentTimestampMs !== null && timestampMs === currentTimestampMs
    const startsBlock = startsBlockPayload(payload)
    const continuation = current.length > 0 && (
      braceDepth > 0 ||
      isContinuationPayload(payload) ||
      (sameTimestamp && startsBlock)
    )

    if (!continuation && current.length > 0) {
      records.push(current.join('\n'))
      current = []
      braceDepth = 0
      currentTimestampMs = null
    }

    if (current.length === 0) currentTimestampMs = timestampMs
    current.push(line)
    braceDepth = Math.max(0, braceDepth + braceDelta(payload))
    if (startsBlock && braceDepth === 0) braceDepth = 1
  }

  if (current.length > 0) records.push(current.join('\n'))
  return records
}

function splitRecord(record: string): { timestamp: Date | null; payload: string } {
  let timestamp: Date | null = null
  const payload = record
    .split('\n')
    .map((line) => {
      const split = splitTimestamp(line)
      if (!timestamp && split.timestamp) timestamp = split.timestamp
      return split.rest.trimEnd()
    })
    .join('\n')
    .trim()

  return { timestamp, payload }
}

function rawLogLines(text: string | null | undefined): string[] {
  return (text?.trimEnd() || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

function recordJson(record: string): Record<string, unknown> | null {
  const { payload } = splitRecord(record)
  if (!payload.trimStart().startsWith('{')) return null
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function filterLogRecords(
  text: string | null | undefined,
  keep: (row: Record<string, unknown> | null, record: string) => boolean,
): string {
  return groupLogRecords(rawLogLines(text))
    .filter((record) => keep(recordJson(record), record))
    .join('\n')
}

export function filterMcpServiceLogs(text: string | null | undefined): string {
  return filterLogRecords(text, (row) => {
    if (!row) return true
    if (typeof row.mcpSessionId === 'string') return false
    return row.msg !== 'api' && row.msg !== 'mcp request'
  })
}

export function filterMcpSessionLogs(text: string | null | undefined, sessionId: string): string {
  return filterLogRecords(text, (row) => row?.mcpSessionId === sessionId)
}

export function parseLogEntries(text: string | null | undefined, options: ParseLogOptions = {}): FormattedLogEntry[] {
  const fallback = options.fallback ?? '(no output yet)'
  const fallbackLevel = options.fallbackLevel ?? 'info'
  const fallbackTimestamp = parseDate(options.fallbackTimestamp)
  const rawLines = rawLogLines(text).length > 0 ? rawLogLines(text) : rawLogLines(fallback)
  const records = groupLogRecords(rawLines)

  let lastTimestamp = fallbackTimestamp
  const entries = records.map((record) => {
    const split = splitRecord(record)
    const payload = split.payload
    const json = parseJsonPayload(payload, fallbackLevel)
    const timestamp = split.timestamp ?? json?.timestamp ?? lastTimestamp
    if (timestamp) lastTimestamp = timestamp
    const level = json?.level ?? inferLevel(payload, fallbackLevel)
    const message = json?.message ?? stripLevelPrefix(payload)
    return { timestamp, level, message }
  })

  return options.maxLines ? entries.slice(-options.maxLines) : entries
}

export function formatLogTimestamp(timestamp: Date | null, mode: LogTimeMode): string {
  if (!timestamp) return '0000-00-00 00:00:00.000'
  const getter = mode === 'server'
    ? {
      year: timestamp.getUTCFullYear(),
      month: timestamp.getUTCMonth() + 1,
      day: timestamp.getUTCDate(),
      hour: timestamp.getUTCHours(),
      minute: timestamp.getUTCMinutes(),
      second: timestamp.getUTCSeconds(),
      ms: timestamp.getUTCMilliseconds(),
    }
    : {
      year: timestamp.getFullYear(),
      month: timestamp.getMonth() + 1,
      day: timestamp.getDate(),
      hour: timestamp.getHours(),
      minute: timestamp.getMinutes(),
      second: timestamp.getSeconds(),
      ms: timestamp.getMilliseconds(),
    }
  return `${getter.year}-${pad(getter.month)}-${pad(getter.day)} ${pad(getter.hour)}:${pad(getter.minute)}:${pad(getter.second)}.${pad(getter.ms, 3)}`
}
