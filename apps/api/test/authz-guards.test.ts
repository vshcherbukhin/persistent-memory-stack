/**
 * Authorization preHandler-adapter matrix (authz/guards.ts). Proves the
 * deny-by-default access model (docs/internal/users_roles.md):
 *   • the DATA plane requires team membership (a team-less caller is rejected —
 *     even a global super-admin, who manages memories only on the dashboard).
 *   • the CONTROL gate keys on admin_level (admin or superuser).
 *   • assign-admin-level / super-admin ops are superuser-only.
 *   • a missing identity is a fail-closed 401, never open.
 *
 * The crux cell: a team-less super-admin PASSES requireAdmin but FAILS
 * requireTeamMember — the entry-point split the whole model rests on.
 *
 * The pure decideX matrices live in guards.test.ts / *-decision.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { FastifyRequest } from 'fastify'
import {
  requireTeamMember,
  requireAdmin,
  requireSuperuser,
} from '../src/authz/guards.ts'
import { AuthError, ForbiddenError } from '../src/authz/errors.ts'
import type { TenantCtx } from '@pm/db'

function reqWith(identity?: Partial<TenantCtx>): FastifyRequest {
  const base: TenantCtx = {
    userId: 'u',
    teamId: 't',
    adminLevel: 'none',
    isTeamMember: true,
    isTeamAdmin: false,
    isGlobalSuperuser: false,
    mountedTeamIds: [],
    insideTenantTx: false,
  }
  return {
    identity: identity ? { ...base, ...identity } : undefined,
  } as unknown as FastifyRequest
}

/** A team-less identity (e.g. the global super-admin). */
function teamless(partial?: Partial<TenantCtx>): Partial<TenantCtx> {
  return { teamId: null, isTeamMember: false, ...partial }
}

const reply = {} as never
const run = (
  guard: (req: FastifyRequest, reply: never, done: never) => unknown,
  req: FastifyRequest,
) => (guard as (r: FastifyRequest, y: never) => Promise<void>)(req, reply)

describe('preHandler: fail-closed when identity is missing → 401', () => {
  it.each([
    ['requireTeamMember', requireTeamMember],
    ['requireAdmin', requireAdmin],
    ['requireSuperuser', requireSuperuser],
  ])('%s throws AuthError(401) with no identity', async (_name, guard) => {
    await expect(run(guard as never, reqWith(undefined))).rejects.toBeInstanceOf(AuthError)
  })
})

describe('preHandler: requireTeamMember (data plane)', () => {
  it('allows a team member', async () => {
    await expect(run(requireTeamMember as never, reqWith({ isTeamMember: true, teamId: 't' }))).resolves.toBeUndefined()
  })
  it('rejects a team-less caller with no_team', async () => {
    await expect(
      run(requireTeamMember as never, reqWith(teamless())),
    ).rejects.toMatchObject({ code: 'no_team', statusCode: 403 })
  })
  it('rejects a team-less GLOBAL super-admin (MCP requires a team)', async () => {
    await expect(
      run(requireTeamMember as never, reqWith(teamless({ adminLevel: 'superuser', isGlobalSuperuser: true }))),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('preHandler: requireAdmin (control plane)', () => {
  it('allows admin and superuser', async () => {
    await expect(run(requireAdmin as never, reqWith({ adminLevel: 'admin', isTeamAdmin: true }))).resolves.toBeUndefined()
    await expect(run(requireAdmin as never, reqWith({ adminLevel: 'superuser', isGlobalSuperuser: true }))).resolves.toBeUndefined()
  })
  it('denies none', async () => {
    await expect(
      run(requireAdmin as never, reqWith({ adminLevel: 'none' })),
    ).rejects.toMatchObject({ code: 'admin_required' })
  })
  it('CRUX: a team-less super-admin PASSES requireAdmin but FAILS requireTeamMember', async () => {
    const su = reqWith(teamless({ adminLevel: 'superuser', isGlobalSuperuser: true }))
    await expect(run(requireAdmin as never, su)).resolves.toBeUndefined()
    await expect(run(requireTeamMember as never, su)).rejects.toMatchObject({ code: 'no_team' })
  })
})

describe('preHandler: requireSuperuser', () => {
  it('allows superuser only', async () => {
    await expect(run(requireSuperuser as never, reqWith({ adminLevel: 'superuser', isGlobalSuperuser: true }))).resolves.toBeUndefined()
  })
  it('denies admin (privilege-escalation guard)', async () => {
    await expect(
      run(requireSuperuser as never, reqWith({ adminLevel: 'admin', isTeamAdmin: true })),
    ).rejects.toMatchObject({ code: 'superuser_required' })
  })
})
