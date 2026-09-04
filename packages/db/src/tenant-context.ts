/**
 * persistent-memory — tenant context + the runInTenant() RLS wrapper.
 *
 * Identity is SERVER-DERIVED from the token (see api/src/auth/). It is carried
 * for the whole request via AsyncLocalStorage so deep handler code can call
 * runInTenant() with no plumbing. The wrapper opens ONE interactive transaction,
 * sets the RLS GUCs as its first statements, and runs the caller's DB work
 * against the SAME tx client — so every query sees the per-request GUCs.
 *
 * ACCESS MODEL: docs/internal/users_roles.md. The GUCs encode it:
 *   app.user_id          — author; the memory ownership floor compares to it.
 *   app.team_id          — current team (write target). '' when none.
 *   app.can_read_all     — universal read flag (any team member, or a global admin).
 *   app.is_global_admin  — super-admin dashboard cross-team write path.
 *   app.bypass_owner_floor — team-admin / super-admin may edit any author's row.
 *
 * Widening is ALWAYS via these GUCs (read by RLS POLICY), NEVER a role bypass —
 * pm_app stays NOSUPERUSER/NOBYPASSRLS. runInTenant re-checks ctx.isGlobalSuperuser
 * so a handler cannot grant itself the global path by passing the flag.
 *
 * WHY a wrapper and not a $extends hook (confirmed gotcha): a Prisma 7 query
 * extension's callback gets only a `query(args)` thunk bound to an already-chosen
 * pooled connection — no tx handle. Any set_config issued there lands on a
 * DIFFERENT connection than the query. The transaction must OWN the GUC statements.
 *
 * WHY set_config(..., true) and not raw `SET LOCAL`: set_config takes a BIND
 * PARAM (injection-proof) and the 3rd arg `true` == is_local == SET LOCAL, which
 * auto-resets at COMMIT/ROLLBACK so it never leaks onto the pooled connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AdminLevel } from '../../../generated/prisma/client.ts'
import { prisma } from './prisma.ts'

/** Server-DERIVED identity + tenant scope. The client NEVER asserts any of these. */
export interface TenantCtx {
  userId: string
  /** Own team (uuid), or null for a team-less (independent) super-admin. */
  teamId: string | null
  adminLevel: AdminLevel
  /** Has a team (teamId !== null). Required for any data-plane operation. */
  isTeamMember: boolean
  /** admin_level === 'admin' (always team-bound per the access model). */
  isTeamAdmin: boolean
  /** admin_level === 'superuser' — global control plane + dashboard cross-team. */
  isGlobalSuperuser: boolean
  /** Teams this team has MOUNTED — cross-team MEMORY reads via the MCP (own first
   *  is the team itself; these are the additional/mounted teams). */
  mountedTeamIds: string[]
  /** Set true only inside runInTenant — the $extends audit guard reads this. */
  insideTenantTx: boolean
}

export const tenantStore = new AsyncLocalStorage<TenantCtx>()

/** Read the current request's tenant context; throws if called unscoped. */
export function getCtx(): TenantCtx {
  const ctx = tenantStore.getStore()
  if (!ctx) {
    throw new Error(
      'No tenant context — runInTenant()/getCtx() called outside an ' +
        'authenticated request (the auth hook enters the ALS scope).',
    )
  }
  return ctx
}

/**
 * Tx client type = the CONCRETE, fully-parameterized client type (`typeof
 * prisma`). We deliberately do NOT use `Prisma.TransactionClient` nor a mapped
 * `Omit<...>`: in the Prisma 7 `prisma-client` emit BOTH degrade delegate
 * return-type inference. Using the client type verbatim preserves full delegate
 * types — the runtime `tx` value is exactly that client bound to the tx.
 */
export type Tx = typeof prisma

/**
 * Options that widen the default (data-plane, current-team) scope.
 *
 *   globalAdmin    — the dashboard super-admin cross-team write path. Sets
 *                    app.is_global_admin=true. Re-checked against
 *                    ctx.isGlobalSuperuser (a handler cannot self-elevate).
 *   teamIdOverride — the team a cross-team dashboard op targets (defaults to
 *                    ctx.teamId). Pass the target row's team for an edit/delete.
 *   readOnly       — a global-admin / cross-team READ (export, admin list). Sets
 *                    can_read_all without requiring a current team.
 */
export interface TenantRunOpts {
  globalAdmin?: boolean
  teamIdOverride?: string | null
  readOnly?: boolean
  /** Span ALL teams for MEMORY reads (the dashboard view). The MCP/data-plane
   *  leaves this false → memory reads are own ∪ mounted. */
  readAllMemory?: boolean
}

/**
 * Run data-plane work inside a tenant-scoped transaction. The set_config
 * statements run FIRST, then the caller's `fn` against the same `tx`. The ALS
 * `insideTenantTx` flag is flipped for the duration so the audit guard
 * (packages/db/src/prisma.ts) won't false-positive on queries issued through `prisma`.
 */
export async function runInTenant<T>(
  fn: (tx: Tx) => PromiseLike<T>,
  opts: TenantRunOpts = {},
): Promise<T> {
  const ctx = getCtx() // server-derived; never from the request body

  const globalAdmin = opts.globalAdmin === true && ctx.isGlobalSuperuser
  const effectiveTeamId =
    opts.teamIdOverride !== undefined ? opts.teamIdOverride : ctx.teamId

  // Fail-closed: a team-scoped WRITE needs a target team. Reads (readOnly) and
  // the global-admin write path (global_write WITH CHECK is pm_is_global_admin())
  // do not — but a non-global write with no team is a bug, deny it loudly.
  if (!opts.readOnly && !globalAdmin && (effectiveTeamId === null || effectiveTeamId === undefined)) {
    throw new Error(
      'No team context — a team-scoped data write requires a current team. A ' +
        'team-less caller must use the global-admin path (dashboard) or readOnly.',
    )
  }

  const canReadAll = ctx.isTeamMember || globalAdmin // SHARED tables (docs/graph) — universal
  const readAllMemory = opts.readAllMemory === true || globalAdmin // MEMORY universal (dashboard)
  const mountedCsv = ctx.mountedTeamIds.join(',') // '' → {} (own-team only)
  const bypassOwnerFloor = ctx.isTeamAdmin || ctx.isGlobalSuperuser || globalAdmin

  return prisma.$transaction(async (txRaw) => {
    // Prisma 7's $transaction callback type does NOT surface $executeRaw / model
    // delegates to the checker (generated class.ts is @ts-nocheck). At runtime
    // txRaw IS the client bound to the tx connection — our `Tx`. Cast once.
    const tx = txRaw as unknown as Tx
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`
    await tx.$executeRaw`SELECT set_config('app.team_id', ${effectiveTeamId ?? ''}, true)`
    await tx.$executeRaw`SELECT set_config('app.can_read_all', ${canReadAll ? 'true' : 'false'}, true)`
    await tx.$executeRaw`SELECT set_config('app.mounted_team_ids', ${mountedCsv}, true)`
    await tx.$executeRaw`SELECT set_config('app.read_all_memory', ${readAllMemory ? 'true' : 'false'}, true)`
    await tx.$executeRaw`SELECT set_config('app.is_global_admin', ${globalAdmin ? 'true' : 'false'}, true)`
    await tx.$executeRaw`SELECT set_config('app.bypass_owner_floor', ${bypassOwnerFloor ? 'true' : 'false'}, true)`

    ctx.insideTenantTx = true
    try {
      return await fn(tx)
    } finally {
      ctx.insideTenantTx = false
    }
  })
}
