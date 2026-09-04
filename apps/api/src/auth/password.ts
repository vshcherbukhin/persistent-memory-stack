/**
 * persistent-memory-api — password hashing (P1, full-local redesign).
 *
 * The OPTIONAL local-dashboard password is a UI SOFT LOCK only (the local API/MCP
 * stay no-auth — single-user local machine). It is argon2id-hashed with the SAME
 * params + TOKEN_PEPPER as the token secrets (token-service.ts), so a DB dump alone
 * can't be brute-forced. Shared by ensureLocalIdentity (seed-on-create), the
 * /local/auth verify route, and the /profile set/change route.
 *
 * verifyPassword NEVER throws — a malformed/garbage stored hash is a denial (false),
 * not a 500 (mirrors token-service.verifyToken's fail-safe).
 */
import argon2 from 'argon2'
import { randomInt } from 'node:crypto'
import { config } from '../config.ts'

export type PasswordStrengthLevel = 'red' | 'yellow' | 'green'

export interface PasswordStrength {
  score: number
  level: PasswordStrengthLevel
  accepted: boolean
  messages: string[]
}

const GENERATED_WORDS = [
  'Cactus', 'River', 'Signal', 'Copper', 'Atlas', 'Orbit', 'Marble', 'Harbor',
  'Quartz', 'Lumen', 'Falcon', 'Cedar', 'Vector', 'Nimbus', 'Summit', 'Willow',
]

/** argon2id params — read at call time so env overrides apply (match token-service/seed). */
function argonOptions(): argon2.Options {
  return {
    type: argon2.argon2id,
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
  }
}

/** Hash a plaintext password (peppered) for storage. */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain + config.TOKEN_PEPPER, argonOptions())
}

/** Verify a plaintext password against a stored hash. False (never throws) on mismatch
 * OR a malformed stored hash. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain + config.TOKEN_PEPPER)
  } catch {
    return false
  }
}

export function assessPasswordStrength(password: string): PasswordStrength {
  const messages: string[] = []
  let score = 0

  if (password.length >= 14) score += 2
  else if (password.length >= 10) score += 1
  else messages.push('Use at least 14 characters.')

  if (/[a-z]/.test(password)) score += 1
  else messages.push('Add a lowercase letter.')

  if (/[A-Z]/.test(password)) score += 1
  else messages.push('Add an uppercase letter.')

  if (/[0-9]/.test(password)) score += 1
  else messages.push('Add a number.')

  if (/[^A-Za-z0-9]/.test(password)) score += 1
  else messages.push('Add a symbol.')

  const lowered = password.toLowerCase()
  if (/(password|admin|welcome|persistent|memory|qwerty|letmein)/.test(lowered)) {
    score = Math.min(score, 2)
    messages.push('Avoid common words and product names.')
  }
  if (/(.)\1\1/.test(password)) {
    score = Math.min(score, 3)
    messages.push('Avoid repeated characters.')
  }

  const level: PasswordStrengthLevel = score >= 5 ? 'green' : score >= 3 ? 'yellow' : 'red'
  return {
    score,
    level,
    accepted: level === 'green',
    messages,
  }
}

export function generateStrongPassword(): string {
  const a = GENERATED_WORDS[randomInt(GENERATED_WORDS.length)]!
  let b = GENERATED_WORDS[randomInt(GENERATED_WORDS.length)]!
  while (b === a) b = GENERATED_WORDS[randomInt(GENERATED_WORDS.length)]!
  const number = String(randomInt(10, 99))
  const symbols = ['!', '#', '%', '*', '+', '-', '?']
  const symbol = symbols[randomInt(symbols.length)]!
  return `${a}-${b}-${number}${symbol}`
}
