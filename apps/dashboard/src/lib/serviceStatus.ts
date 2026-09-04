export type ServiceStatusKind = 'healthy' | 'running' | 'stopped' | 'error' | 'unknown'

type ServiceStatusSubject = {
  state: string
  status: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
}

function serviceExitCode(service: ServiceStatusSubject): number | null {
  const match = service.status.match(/Exited \((\d+)\)/i)
  return match ? Number(match[1]) : null
}

export function serviceIsActive(service: ServiceStatusSubject): boolean {
  return service.state === 'running' || service.state === 'reachable' || service.state === 'healthy'
}

/** Keep logical dependency observations honest: unknown is not stopped. */
export function serviceStatusKind(service: ServiceStatusSubject): ServiceStatusKind {
  if (service.health === 'unhealthy' || service.state === 'unreachable' || service.state === 'dead') return 'error'
  if (service.state === 'unknown') return 'unknown'
  if (service.state === 'exited') {
    const code = serviceExitCode(service)
    return code != null && code !== 0 ? 'error' : 'stopped'
  }
  if (service.state === 'healthy') return 'healthy'
  if (service.health === 'healthy' || serviceIsActive(service)) return 'running'
  return 'stopped'
}
