import type { ServiceInfo } from './docker.ts'

export interface ServiceSummary {
  total: number
  active: number
  stopped: number
  failed: number
  healthy: number
  unhealthy: number
  starting: number
  unavailable: boolean
}

export function isServiceUp(row: ServiceInfo): boolean {
  return !isServiceFailed(row) && !isServiceStarting(row) && (row.health === 'healthy' || row.state === 'running' || row.state === 'reachable')
}

function isServiceStarting(row: ServiceInfo): boolean {
  return row.health === 'starting' || row.state === 'starting' || row.state === 'restarting'
}

export function isServiceDown(row: ServiceInfo): boolean {
  return row.health === 'unhealthy' || row.state === 'unreachable' || row.state === 'exited'
}

export function isServiceFailed(row: ServiceInfo): boolean {
  return row.health === 'unhealthy' || row.state === 'unreachable' || row.state === 'dead'
}

export function summarizeServiceRows(rows: ServiceInfo[]): ServiceSummary {
  const active = rows.filter((row) => isServiceUp(row)).length
  const failed = rows.filter((row) => !isServiceUp(row) && isServiceFailed(row)).length
  const starting = rows.filter(row => !isServiceFailed(row) && isServiceStarting(row)).length
  const stopped = rows.length - active - failed - starting
  const healthy = active
  const unhealthy = rows.filter((row) => !isServiceUp(row) && isServiceDown(row)).length
  return {
    total: rows.length,
    active,
    stopped,
    failed,
    healthy,
    unhealthy,
    starting,
    unavailable: false,
  }
}
