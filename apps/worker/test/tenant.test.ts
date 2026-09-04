/**
 * Unit matrix for the worker tenant-scope bridge (src/tenant.ts) — the load-
 * bearing P6 worker gotcha.
 *
 * buildWorkerCtx must:
 *   • take teamId VERBATIM from the (server-derived-at-enqueue) job payload,
 *   • be a plain team member (isTeamMember=true, no admin) scoped to that team —
 *     RLS team_write WITH CHECK validates own-team writes,
 *   • set adminLevel=none / insideTenantTx=false / userId='worker'.
 *
 * withWorkerTenant must run its body INSIDE tenantStore.run(ctx) so a nested
 * getCtx() resolves (the run()-not-enterWith requirement). We assert the store is
 * populated for the WHOLE async body (across an await), which is exactly what the
 * BullMQ processor relies on.
 */
import { describe, it, expect } from 'vitest'
import { tenantStore } from '@pm/db'
import type { IngestJobData } from '@pm/shared'
import { buildWorkerCtx, buildSystemCtx, withWorkerTenant } from '../src/tenant.ts'

const job: IngestJobData = {
  ingestJobId: 'job-1',
  sourceId: 'src-1',
  documentId: 'doc-1',
  teamId: 'team-own',
  project: 'general',
  minioObjectKey: 'team/team-own/general/src-1/original/x.pdf',
  mimeType: 'application/pdf',
  filename: 'x.pdf',
  sessionId: null,
}

describe('buildWorkerCtx', () => {
  it('takes teamId verbatim from the job payload', () => {
    expect(buildWorkerCtx(job).teamId).toBe('team-own')
  })

  it('is a plain team member scoped to the job team', () => {
    const ctx = buildWorkerCtx(job)
    expect(ctx.isTeamMember).toBe(true)
    expect(ctx.isTeamAdmin).toBe(false)
    expect(ctx.isGlobalSuperuser).toBe(false)
  })

  it('is a none / not-yet-in-tx system actor', () => {
    const ctx = buildWorkerCtx(job)
    expect(ctx.adminLevel).toBe('none')
    expect(ctx.userId).toBe('worker')
    expect(ctx.insideTenantTx).toBe(false)
  })
})

describe('buildSystemCtx (cross-team maintenance — embed-backfill)', () => {
  it('is a team-less global superuser (enables the global-admin RLS path)', () => {
    const ctx = buildSystemCtx()
    expect(ctx.teamId).toBeNull()
    expect(ctx.isGlobalSuperuser).toBe(true)
    expect(ctx.isTeamMember).toBe(false)
  })

  it('uses an EMPTY userId, not "worker" — app.user_id is cast to uuid by the memory owner_floor', () => {
    // 'worker' would throw "invalid input syntax for type uuid" on a memory UPDATE
    // (pm_current_user_id() casts app.user_id even when is_global_admin is true);
    // '' → NULL → the floor falls through to the global-admin branch.
    expect(buildSystemCtx().userId).toBe('')
  })
})

describe('withWorkerTenant', () => {
  it('populates the ALS store for the whole async body (run, not enterWith)', async () => {
    const seen = await withWorkerTenant(job, async () => {
      // Before an await:
      const a = tenantStore.getStore()?.teamId
      await Promise.resolve()
      // After an await — must STILL be populated (the processor-body invariant):
      const b = tenantStore.getStore()?.teamId
      return { a, b }
    })
    expect(seen).toEqual({ a: 'team-own', b: 'team-own' })
  })

  it('clears the store outside the run body', async () => {
    await withWorkerTenant(job, async () => undefined)
    expect(tenantStore.getStore()).toBeUndefined()
  })
})
