import { createHmac, timingSafeEqual } from 'node:crypto'
import { ownerPrisma } from '@pm/db'
import { config } from '../config.ts'

const PREFIX = 'pm_session'
const DEFAULT_TTL_SECONDS = 60 * 60 * 8

interface Payload {
  sub: string
  iat: number
  exp: number
}

export interface IssueDashboardSessionInput {
  userId: string
  nowMs?: number
  ttlSeconds?: number
}

export interface VerifyDashboardSessionOptions {
  nowMs?: number
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function sign(payload: string): string {
  return createHmac('sha256', config.TOKEN_PEPPER).update(payload).digest('base64url')
}

function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}

export function isDashboardSessionToken(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.startsWith(`${PREFIX}.`)
}

export function issueDashboardSession(input: IssueDashboardSessionInput): string {
  const now = input.nowMs ?? Date.now()
  const iat = Math.floor(now / 1000)
  const exp = iat + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS)
  const payload = b64url(JSON.stringify({ sub: input.userId, iat, exp } satisfies Payload))
  return `${PREFIX}.${payload}.${sign(payload)}`
}

function parse(raw: string): Payload | null {
  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null
  if (!equal(sign(parts[1]), parts[2])) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Partial<Payload>
    if (typeof payload.sub !== 'string' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      return null
    }
    return { sub: payload.sub, iat: payload.iat, exp: payload.exp }
  } catch {
    return null
  }
}

export async function verifyDashboardSession(
  raw: string | undefined,
  options: VerifyDashboardSessionOptions = {},
) {
  if (!raw || !isDashboardSessionToken(raw)) return null
  const payload = parse(raw)
  if (!payload) return null
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000)
  if (payload.exp <= now) return null

  const user = await ownerPrisma.appUser.findUnique({ where: { id: payload.sub } })
  if (!user) return null
  const changedAt = (user as { passwordChangedAt?: Date | null }).passwordChangedAt
  if (changedAt && Math.floor(changedAt.getTime() / 1000) > payload.iat) return null
  return user
}
