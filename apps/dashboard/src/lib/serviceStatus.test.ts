import { describe, expect, it } from 'vitest'
import { serviceStatusKind } from './serviceStatus'

describe('serviceStatusKind', () => {
  it('keeps startup distinct from healthy, running and stopped', () => {
    expect(serviceStatusKind({ state: 'starting', status: 'Model loading', health: 'starting' })).toBe('starting')
    expect(serviceStatusKind({ state: 'running', status: 'Up', health: 'starting' })).toBe('starting')
  })
  it('renders a healthy logical capability as healthy while physical containers remain running', () => {
    expect(serviceStatusKind({ state: 'healthy', status: 'healthy', health: 'healthy' })).toBe('healthy')
    expect(serviceStatusKind({ state: 'running', status: 'Up', health: 'healthy' })).toBe('running')
    expect(serviceStatusKind({ state: 'unknown', status: 'not observed', health: null })).toBe('unknown')
  })
})
