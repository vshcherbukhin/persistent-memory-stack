export type McpConnectionType = 'stream' | 'stdio'

export interface McpClientInput {
  id: string
  clientName: string
  connectionType: McpConnectionType
  pid?: number
  terminateSupported?: boolean
  lastActivityAt?: string
}

export interface McpClientHeartbeatInput {
  lastActivityAt?: string
}

export interface McpClientStatus {
  id: string
  clientName: string
  connectionType: McpConnectionType
  pid: number | null
  startedAt: string
  lastSeenAt: string
  lastActivityAt: string
  terminatesAt: string | null
  terminateSupported: boolean
  terminateRequested: boolean
}

interface McpClientRecord {
  id: string
  clientName: string
  connectionType: McpConnectionType
  pid: number | null
  startedAt: string
  lastSeenAt: string
  lastActivityAt: string
  terminateSupported: boolean
  terminateRequested: boolean
}

export const MCP_SESSION_IDLE_TIMEOUT_DEFAULT_SECONDS = 15 * 60

const clients = new Map<string, McpClientRecord>()

function nowIso(): string {
  return new Date().toISOString()
}

function terminatesAt(client: McpClientRecord, idleTimeoutSeconds: number): string | null {
  if (client.connectionType !== 'stream') return null
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds <= 0) return null
  const lastActivityMs = Date.parse(client.lastActivityAt)
  if (!Number.isFinite(lastActivityMs)) return null
  return new Date(lastActivityMs + idleTimeoutSeconds * 1000).toISOString()
}

function toStatus(client: McpClientRecord, idleTimeoutSeconds: number): McpClientStatus {
  return { ...client, terminatesAt: terminatesAt(client, idleTimeoutSeconds) }
}

export function upsertMcpClient(input: McpClientInput): McpClientStatus {
  const existing = clients.get(input.id)
  const timestamp = nowIso()
  const next: McpClientRecord = {
    id: input.id,
    clientName: input.clientName,
    connectionType: input.connectionType,
    pid: input.pid ?? existing?.pid ?? null,
    startedAt: existing?.startedAt ?? timestamp,
    lastSeenAt: timestamp,
    lastActivityAt: input.lastActivityAt ?? existing?.lastActivityAt ?? timestamp,
    terminateSupported: input.terminateSupported ?? input.connectionType === 'stdio',
    terminateRequested: existing?.terminateRequested ?? false,
  }
  clients.set(input.id, next)
  return toStatus(next, MCP_SESSION_IDLE_TIMEOUT_DEFAULT_SECONDS)
}

export function heartbeatMcpClient(id: string, input: McpClientHeartbeatInput = {}): { terminate: boolean; registered: boolean } {
  const existing = clients.get(id)
  if (!existing) return { terminate: false, registered: false }
  clients.set(id, {
    ...existing,
    lastSeenAt: nowIso(),
    lastActivityAt: input.lastActivityAt ?? existing.lastActivityAt,
  })
  return { terminate: existing.terminateRequested, registered: true }
}

export function closeMcpClient(id: string): void {
  clients.delete(id)
}

export function terminateMcpClient(id: string): { ok: boolean; reason?: 'not_found' | 'not_terminable' } {
  const existing = clients.get(id)
  if (!existing) return { ok: false, reason: 'not_found' }
  if (!existing.terminateSupported) return { ok: false, reason: 'not_terminable' }
  clients.set(id, { ...existing, terminateRequested: true, lastSeenAt: nowIso() })
  return { ok: true }
}

export function pruneIdleMcpClients(
  idleTimeoutSeconds: number = MCP_SESSION_IDLE_TIMEOUT_DEFAULT_SECONDS,
  now: Date = new Date(),
): number {
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds <= 0) return clients.size
  const cutoffMs = now.getTime() - idleTimeoutSeconds * 1000
  for (const [id, client] of clients.entries()) {
    if (client.connectionType !== 'stream') continue
    const lastActivityMs = Date.parse(client.lastActivityAt)
    if (Number.isFinite(lastActivityMs) && lastActivityMs <= cutoffMs) clients.delete(id)
  }
  return clients.size
}

export function listMcpClients(idleTimeoutSeconds: number = MCP_SESSION_IDLE_TIMEOUT_DEFAULT_SECONDS): McpClientStatus[] {
  return [...clients.values()]
    .map((client) => toStatus(client, idleTimeoutSeconds))
    .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.startedAt.localeCompare(b.startedAt))
}

export function resetMcpClientsForTest(): void {
  clients.clear()
}
