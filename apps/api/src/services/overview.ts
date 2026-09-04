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
  return row.health === 'healthy' || row.state === 'running' || row.state === 'reachable'
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
  const stopped = rows.length - active - failed
  const healthy = active
  const unhealthy = rows.filter((row) => !isServiceUp(row) && isServiceDown(row)).length
  return {
    total: rows.length,
    active,
    stopped,
    failed,
    healthy,
    unhealthy,
    starting: rows.length - healthy - unhealthy,
    unavailable: false,
  }
}
