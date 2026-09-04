/**
 * persistent-memory-api — /dashboard route shared helpers.
 *
 * The control plane: teams / users / tokens / settings / memories. EVERY
 * handler here uses ownerPrisma for the CONTROL tables (team / app_user /
 * team_grant / local_identity / system_settings live OUTSIDE RLS; pm_app has no grant). The dashboard memory
 * surface (/dashboard/memories) uses runInTenant with the global-admin
 * RLS path instead. requireAdmin gates the whole scope; requireSuperuser is
 * added per-route on the escalation ops (admin_level assignment + settings PUT).
 */
import { Prisma } from '@pm/db'
import { ForbiddenError } from '../../authz/errors.ts'

/** A 409 conflict surfaced through the existing ForbiddenError→reply path is
 * wrong (403). Control-plane domain conflicts need a real 409, so define a tiny
 * typed error the route handlers throw and the central handler renders. */
export class ConflictError extends Error {
  readonly statusCode = 409 as const
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404 as const
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/** Re-export ForbiddenError so admin modules import everything from one place. */
export { ForbiddenError }

/** True iff err is a Prisma known-request error with the given code (P2002 etc.). */
export function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
}

/** P2025 = "record to update/delete not found". Map to a 404 the route owns. */
export function notFoundIfMissing(err: unknown, code: string, message: string): never {
  if (isPrismaError(err, 'P2025')) throw new NotFoundError(code, message)
  throw err
}

/** Fields needed to build the admin AppUser response. NEVER return this object
 * directly: tokenHash is excluded, but passwordHash is selected only so routes can
 * derive hasPassword before sanitizing through toOut(). tokenId is a non-secret
 * lookup handle; hasToken is derived. */
export const USER_SAFE_SELECT = {
  id: true,
  teamId: true,
  adminLevel: true,
  email: true,
  displayName: true,
  tokenId: true,
  tokenExpires: true,
  tokenIssuedAt: true,
  passwordHash: true,
  passwordTemporary: true,
  passwordChangedAt: true,
  createdAt: true,
  updatedAt: true,
} as const
