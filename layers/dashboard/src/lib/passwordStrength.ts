export type PasswordStrengthLevel = 'red' | 'yellow' | 'green'

export interface PasswordStrength {
  level: PasswordStrengthLevel
  score: number
  accepted: boolean
  messages: string[]
}

const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?'

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
  if (/\d/.test(password)) score += 1
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

  const accepted = score >= 5
  return {
    level: accepted ? 'green' : score >= 3 ? 'yellow' : 'red',
    score,
    accepted,
    messages,
  }
}

function pick(chars: string): string {
  const bytes = new Uint32Array(1)
  globalThis.crypto.getRandomValues(bytes)
  return chars[bytes[0] % chars.length]
}

export function generateStrongPassword(): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digits = '23456789'
  const all = `${lower}${upper}${digits}${SYMBOLS}`
  const chars = [
    pick(lower),
    pick(lower),
    pick(upper),
    pick(upper),
    pick(digits),
    pick(digits),
    pick(SYMBOLS),
    pick(SYMBOLS),
    ...Array.from({ length: 12 }, () => pick(all)),
  ]
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const bytes = new Uint32Array(1)
    globalThis.crypto.getRandomValues(bytes)
    const j = bytes[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
