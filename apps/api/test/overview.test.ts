import { describe, expect, it } from 'vitest'
import type { ServiceInfo } from '../src/services/docker.ts'
import { summarizeServiceRows } from '../src/services/overview.ts'

describe('summarizeServiceRows', () => {
  it('counts running containers with no healthcheck as healthy, matching the Services page', () => {
    const rows: ServiceInfo[] = [
      { service: 'api', name: 'api', id: '1', state: 'running', status: 'Up', health: 'healthy' },
      { service: 'qdrant', name: 'qdrant', id: '2', state: 'running', status: 'Up', health: null },
      { service: 'ollama (host)', name: 'host Ollama', id: '', state: 'reachable', status: 'host-managed', health: null },
    ]

    expect(summarizeServiceRows(rows)).toEqual({
      total: 3,
      active: 3,
      stopped: 0,
      failed: 0,
      healthy: 3,
      unhealthy: 0,
      starting: 0,
      unavailable: false,
    })
  })

  it('keeps exited/unreachable rows out of the healthy count', () => {
    const rows: ServiceInfo[] = [
      { service: 'api', name: 'api', id: '1', state: 'running', status: 'Up', health: 'healthy' },
      { service: 'minio', name: 'minio', id: '2', state: 'exited', status: 'Exited', health: null },
      { service: 'ollama (host)', name: 'host Ollama', id: '', state: 'unreachable', status: 'host-managed', health: 'unhealthy' },
      { service: 'worker', name: 'worker', id: '3', state: 'created', status: 'Created', health: null },
    ]

    expect(summarizeServiceRows(rows)).toMatchObject({
      total: 4,
      active: 1,
      stopped: 2,
      failed: 1,
      healthy: 1,
      unhealthy: 2,
      starting: 1,
    })
  })
})
