import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  countServicesNeedingAttention,
  countWorkersNeedingAttention,
  mergeNavigationHealth,
  securityAlertIndicator,
  servicesAttention,
  workersAttention,
} from './navigation-attention'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const service = (state: string, health: 'healthy' | 'unhealthy' | 'starting' | null = null) => ({
  service: state,
  name: state,
  id: state,
  state,
  status: state,
  health,
  controllable: false,
})

const worker = (overrides: Partial<{ enabled: boolean; status: string; lastError: string | null; errorCount: number }> = {}) => ({
  name: 'graph-lifecycle',
  description: 'test worker',
  cron: '*/2 * * * *',
  enabled: true,
  status: 'success',
  lastRunAt: null,
  lastFinishAt: null,
  lastDurationMs: null,
  lastError: null,
  logTail: null,
  errorCount: 0,
  nextRunAt: null,
  ...overrides,
})

describe('navigation attention indicators', () => {
  it('shows a red exclamation only while unresolved security findings exist, then clears after the final resolution', () => {
    expect(securityAlertIndicator(2)).toEqual({
      label: '2 unresolved security findings',
      visible: true,
    })
    expect(securityAlertIndicator(0)).toEqual({ visible: false })
  })

  it('marks only genuinely unavailable services, without treating start-up or unknown observations as failures', () => {
    expect(countServicesNeedingAttention([service('running', 'healthy'), service('starting', 'starting'), service('unknown')])).toBe(0)
    expect(countServicesNeedingAttention([service('fact-extraction', 'unhealthy'), service('embeddings', 'unhealthy')])).toBe(0)
    expect(servicesAttention(countServicesNeedingAttention([service('exited'), service('unreachable', 'unhealthy')]))).toEqual({
      label: '2 services need attention',
      visible: true,
    })
  })

  it('marks a failed enabled worker or a missing worker heartbeat, but never a deliberately paused job', () => {
    expect(countWorkersNeedingAttention([worker({ enabled: false, status: 'failed', lastError: 'old failure', errorCount: 1 })], { alive: true, lastBeatAgoMs: 1 })).toBe(0)
    expect(workersAttention(countWorkersNeedingAttention([worker({ status: 'failed', lastError: 'boom', errorCount: 1 })], { alive: true, lastBeatAgoMs: 1 }))).toEqual({
      label: '1 worker needs attention',
      visible: true,
    })
    expect(workersAttention(countWorkersNeedingAttention([worker()], { alive: false, lastBeatAgoMs: null }))).toEqual({
      label: '1 worker needs attention',
      visible: true,
    })
  })

  it('updates each marker independently, so one unavailable source cannot freeze a successful security resolution', () => {
    expect(mergeNavigationHealth(
      { securityOpen: 1, servicesDown: 2, workersDown: 1 },
      { securityOpen: 0, workersDown: 0 },
    )).toEqual({ securityOpen: 0, servicesDown: 2, workersDown: 0 })
  })

  it('refreshes the indicators after a security resolve and while the dashboard remains open', () => {
    const nav = source('../components/Nav.tsx')
    const resolveForm = source('../app/(dashboard)/security/ResolveAlertForm.tsx')

    expect(nav).toContain('/api/navigation-health?space=${selectedSpace}')
    expect(nav).toContain("window.addEventListener('pm:navigation-attention-changed'")
    expect(nav).toContain('window.setInterval')
    expect(nav).toContain('securityAlertIndicator(navigationHealth.securityOpen)')
    expect(nav).toContain('servicesAttention(navigationHealth.servicesDown)')
    expect(nav).toContain('workersAttention(navigationHealth.workersDown)')
    expect(nav).toContain('mergeNavigationHealth(current, data)')
    expect(source('../app/api/navigation-health/route.ts')).toContain('Promise.allSettled')
    expect(resolveForm).toContain('if (await resolveAlertAction(formData))')
    expect(resolveForm).toContain("window.dispatchEvent(new Event('pm:navigation-attention-changed'))")
  })
})
