/**
 * Local-dashboard password hashing (P1, full-local redesign).
 *
 * The optional local password is a dashboard-UI SOFT LOCK; it is argon2id-hashed
 * with the same params + TOKEN_PEPPER as the token secrets. This unit pins the
 * round-trip + the fail-safe (a malformed stored hash → false, never a throw, so a
 * corrupt row denies login instead of 500-ing).
 */
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password.ts'

describe('password hashing', () => {
  it('verifies a correct password against its hash', async () => {
    const h = await hashPassword('s3cret-pw')
    expect(await verifyPassword(h, 's3cret-pw')).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const h = await hashPassword('s3cret-pw')
    expect(await verifyPassword(h, 'wrong')).toBe(false)
  })

  it('returns false (never throws) on a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-valid-argon2-hash', 'whatever')).toBe(false)
  })

  it('produces a distinct hash per call (random salt) yet both verify', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    expect(await verifyPassword(a, 'same')).toBe(true)
    expect(await verifyPassword(b, 'same')).toBe(true)
  })
})
