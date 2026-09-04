import { describe, expect, it } from 'vitest'
import { serviceStatusKind } from './serviceStatus'

describe('serviceStatusKind', () => {
  it('renders a healthy logical capability as healthy while physical containers remain running', () => {
    expect(serviceStatusKind({ state: 'healthy', status: 'healthy', health: 'healthy' })).toBe('healthy')
    expect(serviceStatusKind({ state: 'running', status: 'Up', health: 'healthy' })).toBe('running')
    expect(serviceStatusKind({ state: 'unknown', status: 'not observed', health: null })).toBe('unknown')
  })
})
