import type { McpClientStatus, ServiceStatus } from './types'

/** Prototype "Last seen": "2 s ago", "4 min ago". */
export function formatSeenAgo(iso: string, nowMs: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'unknown'
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Time left before an idle stream session is closed: "14m 05s", "1h 2m". */
export function formatMcpTerminateCountdown(terminatesAt: string | null, nowMs: number): string {
  if (!terminatesAt) return 'not managed'
  const deadlineMs = Date.parse(terminatesAt)
  if (!Number.isFinite(deadlineMs)) return 'unknown'
  const remainingMs = deadlineMs - nowMs
  if (remainingMs <= 0) return 'terminating...'
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const restMinutes = minutes % 60
    return `${hours}h ${restMinutes}m`
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function formatMcpTerminateTime(terminatesAt: string | null): string {
  if (!terminatesAt) return ''
  const date = new Date(terminatesAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The stream MCP container: its log carries the communication of every stream session. */
export function streamMcpLogRef(services: ServiceStatus[]): string | null {
  return services.find((service) => service.service === 'mcp' && service.id && service.mcpSession !== true)?.id ?? null
}

/** An open session stays open only while the MCP service still lists its connection. */
export function openSessionAfterRefresh(clients: McpClientStatus[], openId: string | null): string | null {
  return openId && clients.some((client) => client.id === openId) ? openId : null
}
