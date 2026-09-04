'use server'

import { api, ApiError } from '@/lib/api'
import { requireSession, requireControlPlane, isSuperuser } from '@/lib/session'
import { canAccessControlPlane } from '@/lib/authz'
import type { DashboardCapabilityHealth, McpClientStatus, ServiceStatus } from '@/lib/types'

/**
 * Service-monitor actions. Listing + logs are viewable by ANY authenticated user
 * (the design shows Services to members too — the API gates these reads at
 * requireSession, not admin+); start/stop/restart are superuser-only (they
 * control host infrastructure — the API also enforces requireSuperuser). All
 * return readable errors (incl. 503 docker_unavailable).
 */
export async function listServicesAction(): Promise<{ services: ServiceStatus[]; mcpClients: McpClientStatus[]; capabilityHealth?: DashboardCapabilityHealth; error?: string }> {
  const who = await requireSession()
  try {
    const { services, mcpClients, capabilityHealth } = await api.listServices()
    if (canAccessControlPlane(who.adminLevel)) return { services, mcpClients, capabilityHealth }
    return {
      services: services.map((service) => {
        const { credentials: _credentials, ...safe } = service
        return safe
      }),
      mcpClients,
      capabilityHealth,
    }
  } catch (err) {
    if (err instanceof ApiError) return { services: [], mcpClients: [], error: err.message }
    throw err
  }
}

export async function serviceLogsAction(service: string, tail = 200): Promise<{ logs: string; error?: string }> {
  await requireSession()
  try {
    return { logs: (await api.serviceLogs(service, tail)).logs }
  } catch (err) {
    if (err instanceof ApiError) return { logs: '', error: err.message }
    throw err
  }
}

export async function serviceControlAction(
  service: string,
  action: 'start' | 'stop' | 'restart' | 'terminate',
): Promise<{ ok: boolean; error?: string }> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { ok: false, error: 'Only a superuser may control services.' }
  try {
    await api.serviceAction(service, action)
    return { ok: true }
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message }
    throw err
  }
}

export async function mcpClientTerminateAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { ok: false, error: 'Only a superuser may terminate MCP clients.' }
  try {
    const result = await api.mcpClientTerminate(id)
    if (!result.ok) return { ok: false, error: result.reason ?? 'MCP client could not be terminated.' }
    return { ok: true }
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message }
    throw err
  }
}
