import type { ModelDependencyHealth } from './types'

export type CapabilityHealthTone = 'ok' | 'warn' | 'bad'

export type CapabilityHealthPresentation = {
  badge: string
  tone: CapabilityHealthTone
  message: string
  recovery: string
  observedAt: string
}

function observationTime(value: string | null): string {
  if (!value) return 'not observed'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'not observed'
  return `${date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`
}

export function capabilityHealthPresentation(health: ModelDependencyHealth): CapabilityHealthPresentation {
  if (health.state === 'healthy') {
    return {
      badge: 'healthy',
      tone: 'ok',
      message: 'The latest request or test completed successfully.',
      recovery: 'No action needed.',
      observedAt: observationTime(health.lastSuccessAt ?? health.observedAt),
    }
  }
  if (health.state === 'unknown') {
    return {
      badge: 'not checked',
      tone: 'warn',
      message: 'No successful request or test has reported this capability yet.',
      recovery: 'Run a test to establish health.',
      observedAt: 'not observed',
    }
  }
  const outOfTokens = health.failureCode?.includes('quota_exhausted') ?? false
  return {
    badge: outOfTokens ? 'out of tokens' : health.state,
    tone: health.state === 'unhealthy' ? 'bad' : 'warn',
    message: health.safeMessage ?? 'This capability needs attention.',
    recovery: outOfTokens
      ? 'Add tokens or update the provider account, then run a test.'
      : health.retryable
        ? 'Retry the test after the provider recovers.'
        : 'Review the configured model and provider, then run a test.',
    observedAt: observationTime(health.lastFailureAt ?? health.observedAt),
  }
}
