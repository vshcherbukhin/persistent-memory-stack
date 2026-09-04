/**
 * persistent-memory-worker — the tenant-scope bridge (the load-bearing gotcha).
 *
 * There is NO HTTP request in the worker, so the api's two-hook ALS spine
 * (authenticate → enterTenantScope via enterWith) does NOT apply. The worker
 * builds the TenantCtx from the job payload and enters the scope ITSELF — and it
 * MUST use tenantStore.run(ctx, fn), NOT enterWith, because a BullMQ processor is
 * one self-contained async function: run() carries the store across every await
 * inside that lexical body (including the awaited runInTenant). The
 * enterWith-after-await failure mode that bites Fastify does NOT apply here
 * because the processor body is lexically inside run().
 *
 * The worker is a system writer for ONE team: it builds a plain team-member ctx
 * (adminLevel none, isTeamMember true) scoped to job.teamId. RLS team_write WITH
 * CHECK (team_id = pm_current_team_id()) validates every write against that team.
 * The worker never authors Memory rows in the ingest path, so the ownership floor
 * (created_by_id) is irrelevant here.
 */
import { tenantStore, type TenantCtx } from '@pm/db'
import type { IngestJobData } from '@pm/shared'

export function buildWorkerCtx(job: IngestJobData): TenantCtx {
  return {
    userId: 'worker', // synthetic; the worker is a system actor, not a user
    teamId: job.teamId, // server-derived at ENQUEUE time; never from a client
    adminLevel: 'none',
    isTeamMember: true,
    isTeamAdmin: false,
    isGlobalSuperuser: false,
    mountedTeamIds: [], // the worker only WRITES its own team; no cross-team reads
    insideTenantTx: false,
  }
}

/**
 * Run the whole per-job pipeline inside the ALS scope so the nested runInTenant()
 * calls find getCtx(). MUST be run() (not enterWith) wrapping the ENTIRE processor
 * body.
 */
export function withWorkerTenant<T>(job: IngestJobData, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(buildWorkerCtx(job), fn)
}

/**
 * A SYSTEM global ctx for cross-team maintenance jobs (the embed-backfill consumer).
 * Unlike the per-team ingest ctx, this spans ALL teams: isGlobalSuperuser=true lets
 * runInTenant({globalAdmin:true}) take the global-admin RLS path (read/write any
 * team's data via the GUC the policy reads — NOT an ownerPrisma role bypass, so RLS
 * stays the backstop). userId='worker' is a system actor, never a real user.
 */
export function buildSystemCtx(): TenantCtx {
  return {
    // EMPTY, not 'worker': app.user_id is cast to uuid by pm_current_user_id()
    // (NULLIF(...,'')::uuid) inside the memory owner_floor policy, which Postgres
    // still evaluates on an UPDATE even when is_global_admin() is true. 'worker'
    // would throw "invalid input syntax for type uuid"; '' → NULL → the floor
    // falls through to the is_global_admin() branch. (The ingest ctx keeps 'worker'
    // because it only writes chunks — no owner_floor, no uuid cast.)
    userId: '',
    teamId: null,
    adminLevel: 'superuser',
    isTeamMember: false,
    isTeamAdmin: false,
    isGlobalSuperuser: true,
    mountedTeamIds: [],
    insideTenantTx: false,
  }
}

export function withSystemTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(buildSystemCtx(), fn)
}
