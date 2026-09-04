import { describe, expect, it } from 'vitest'
import { assessPasswordStrength } from './passwordStrength'

describe('dashboard password strength', () => {
  it('matches the API minimum length and score expectations', () => {
    expect(assessPasswordStrength('Short1!').accepted).toBe(false)
    expect(assessPasswordStrength('Long-Enough-47!').accepted).toBe(true)
  })

  it('rejects common product words that the API rejects', () => {
    const result = assessPasswordStrength('PersistentMemory47!')

    expect(result.accepted).toBe(false)
    expect(result.messages).toContain('Avoid common words and product names.')
  })
})
