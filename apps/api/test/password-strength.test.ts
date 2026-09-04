import { describe, it, expect } from 'vitest'
import { assessPasswordStrength, generateStrongPassword } from '../src/auth/password.ts'

describe('password strength policy', () => {
  it('declines weak passwords and reports a red score', () => {
    const result = assessPasswordStrength('password')

    expect(result.accepted).toBe(false)
    expect(result.level).toBe('red')
    expect(result.messages.join(' ')).toMatch(/uppercase|number|symbol|length/i)
  })

  it('accepts strong passwords and reports a green score', () => {
    const result = assessPasswordStrength('Cactus-Plane-47!River')

    expect(result.accepted).toBe(true)
    expect(result.level).toBe('green')
    expect(result.score).toBeGreaterThanOrEqual(5)
  })

  it('generates a show-once candidate that satisfies the same policy', () => {
    const generated = generateStrongPassword()
    const result = assessPasswordStrength(generated)

    expect(generated).toMatch(/[A-Z]/)
    expect(generated).toMatch(/[a-z]/)
    expect(generated).toMatch(/[0-9]/)
    expect(generated).toMatch(/[^A-Za-z0-9]/)
    expect(result.accepted).toBe(true)
  })
})
