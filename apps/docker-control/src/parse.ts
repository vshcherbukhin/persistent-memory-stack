/**
 * docker-control — pure parsers for the Docker Engine API responses.
 * Moved verbatim from the api (api/src/services/docker-parse.ts) — the sidecar
 * now owns socket I/O + parsing, and hands the api clean JSON.
 */

export interface ServiceInfo {
  service: string // compose service name (postgres, api, …)
  name: string // container name
  id: string
  state: string // running | exited | created | restarting | …
  status: string // human "Up 2 minutes (healthy)"
  health: 'healthy' | 'unhealthy' | 'starting' | null
  controllable: boolean
  mcpSession: boolean
}

/** Docker Engine filter for every persistent-memory project container.
 * Real compose services and per-client stdio MCP containers both carry this
 * project label. The parser marks only runtime compose services controllable. */
export function memoryContainerFilters(project: string): string {
  return encodeURIComponent(JSON.stringify({
    label: [`com.docker.compose.project=${project}`],
  }))
}

/** Extract container health from the Docker "Status" string. */
export function parseHealth(status: string): ServiceInfo['health'] {
  if (/\(healthy\)/i.test(status)) return 'healthy'
  if (/\(unhealthy\)/i.test(status)) return 'unhealthy'
  if (/health: starting/i.test(status)) return 'starting'
  return null
}

interface RawContainer {
  Id?: string
  Names?: string[]
  State?: string
  Status?: string
  Labels?: Record<string, string>
}

function isRuntimeComposeService(labels: Record<string, string> | undefined): boolean {
  if (!labels) return false
  if (!('com.docker.compose.config-hash' in labels)) return false
  return (labels['com.docker.compose.oneoff'] ?? '').toLowerCase() === 'false'
}

function isMcpSession(labels: Record<string, string> | undefined): boolean {
  return labels?.['persistent-memory.role'] === 'mcp-client'
}

function serviceName(c: RawContainer): string {
  const labels = c.Labels ?? {}
  const labeled = labels['com.docker.compose.service']
  if (labeled) return labeled
  const client = labels['persistent-memory.client']
  if (client) return `${client}-mcp`
  const name = (c.Names?.[0] ?? '').replace(/^\//, '')
  const match = name.match(/^persistent-memory-(.+)-mcp-[^-]+$/)
  if (match?.[1]) return `${match[1]}-mcp`
  return '(unknown)'
}

/** Map the Docker /containers/json array → the stack's ServiceInfo list (sorted). */
export function parseContainers(json: unknown): ServiceInfo[] {
  if (!Array.isArray(json)) return []
  return (json as RawContainer[])
    .map((c) => ({
      service: serviceName(c),
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      id: c.Id ?? '',
      state: c.State ?? 'unknown',
      status: c.Status ?? '',
      health: parseHealth(c.Status ?? ''),
      controllable: isRuntimeComposeService(c.Labels) && !isMcpSession(c.Labels),
      mcpSession: isMcpSession(c.Labels),
    }))
    .sort((a, b) => {
      if (a.controllable !== b.controllable) return a.controllable ? -1 : 1
      return a.service.localeCompare(b.service)
    })
}

/** De-multiplex Docker's framed log stream (8-byte header per frame) → plain text.
 * Falls back to the raw string if the buffer isn't framed (TTY containers). */
export function demuxDockerLog(buf: Buffer): string {
  const out: string[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const type = buf[i]!
    if (type > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) {
      return buf.toString('utf8') // not framed (TTY) — return verbatim
    }
    const size = buf.readUInt32BE(i + 4)
    const start = i + 8
    const end = start + size
    if (end > buf.length) break
    out.push(buf.subarray(start, end).toString('utf8'))
    i = end
  }
  return out.length > 0 ? out.join('') : buf.toString('utf8')
}
