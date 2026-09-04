import type { ServiceStatus, WorkerLiveness, WorkerStatus } from './types'

export type NavigationAttention =
  | { visible: false }
  | { visible: true; label: string }

export type NavigationHealth = {
  securityOpen: number
  servicesDown: number
  workersDown: number
}

export type PartialNavigationHealth = Partial<NavigationHealth>

export function mergeNavigationHealth(current: NavigationHealth, next: PartialNavigationHealth): NavigationHealth {
  return {
    securityOpen: typeof next.securityOpen === 'number' && Number.isFinite(next.securityOpen) ? next.securityOpen : current.securityOpen,
    servicesDown: typeof next.servicesDown === 'number' && Number.isFinite(next.servicesDown) ? next.servicesDown : current.servicesDown,
    workersDown: typeof next.workersDown === 'number' && Number.isFinite(next.workersDown) ? next.workersDown : current.workersDown,
  }
}

function indicator(count: number, singular: string, plural = `${singular}s`): NavigationAttention {
  const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  if (normalized === 0) return { visible: false }
  return {
    visible: true,
    label: `${normalized} ${normalized === 1 ? singular : plural} ${normalized === 1 ? 'needs' : 'need'} attention`,
  }
}

/** Open security findings are review work, so this clears exactly when the final finding is resolved. */
export function securityAlertIndicator(open: number): NavigationAttention {
  const normalized = Number.isFinite(open) ? Math.max(0, Math.floor(open)) : 0
  if (normalized === 0) return { visible: false }
  return {
    visible: true,
    label: `${normalized} unresolved security finding${normalized === 1 ? '' : 's'}`,
  }
}

/** Match the Services page: stopped or error rows are unavailable; starting/unknown are not false alarms. */
export function countServicesNeedingAttention(services: ServiceStatus[]): number {
  return services.filter((service) => {
    if (service.service === 'fact-extraction' || service.service === 'embeddings') return false
    return service.health === 'unhealthy' || ['unreachable', 'dead', 'exited', 'stopped'].includes(service.state)
  }).length
}

export function servicesAttention(down: number): NavigationAttention {
  return indicator(down, 'service')
}

/** A paused job is intentional. Only enabled failed jobs and a missing worker heartbeat need attention. */
export function countWorkersNeedingAttention(workers: WorkerStatus[], liveness: WorkerLiveness | null): number {
  const enabledWorkers = workers.filter((worker) => worker.enabled)
  const failedJobs = enabledWorkers.filter(
    (worker) => worker.status === 'failed' || worker.lastError !== null,
  ).length
  const missingHeartbeat = enabledWorkers.length > 0 && liveness?.alive === false ? 1 : 0
  return failedJobs + missingHeartbeat
}

export function workersAttention(down: number): NavigationAttention {
  return indicator(down, 'worker')
}
