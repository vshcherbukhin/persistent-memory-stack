/**
 * @pm/db usage recorder — currentHourBucket (pure) + the P2002 first-insert-race
 * retry. ownerPrisma is mocked so no DB is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }))
vi.mock('../src/prisma.ts', () => ({ ownerPrisma: { modelUsageRollup: { upsert } } }))

import { currentHourBucket, recordUsage } from '../src/usage.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { tenantStore, type TenantCtx } from '../src/tenant-context.ts'

describe('currentHourBucket', () => {
  it('floors to the start of the UTC hour (minute/sec/ms zeroed)', () => {
    expect(currentHourBucket(new Date('2026-06-26T14:37:42.123Z')).toISOString()).toBe('2026-06-26T14:00:00.000Z')
    expect(currentHourBucket(new Date('2026-01-01T00:59:59.999Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('recordUsage', () => {
  beforeEach(() => upsert.mockReset())

  it('upserts the current-hour bucket with atomic increments', async () => {
    upsert.mockResolvedValueOnce({})
    await recordUsage({ service: 'fact-extraction', model: 'm', tokensIn: 10, tokensOut: 5 }, new Date('2026-06-26T14:30:00Z'))
    expect(upsert).toHaveBeenCalledTimes(1)
    const arg = upsert.mock.calls[0]![0] as {
      where: { hourUtc_service_model_actorId: { hourUtc: Date; service: string; model: string; actorId: string } }
      update: { requests: { increment: number }; tokensIn: { increment: bigint } }
    }
    expect(arg.where.hourUtc_service_model_actorId).toMatchObject({ service: 'fact-extraction', model: 'm', actorId: 'system' })
    expect(arg.where.hourUtc_service_model_actorId.hourUtc.toISOString()).toBe('2026-06-26T14:00:00.000Z')
    expect(arg.update.requests).toEqual({ increment: 1 })
    expect(arg.update.tokensIn).toEqual({ increment: 10n })
  })

  it('attributes request-scoped usage to the current tenant user', async () => {
    upsert.mockResolvedValueOnce({})
    const ctx: TenantCtx = {
      userId: 'user-1',
      teamId: 'team-1',
      adminLevel: 'none',
      isTeamMember: true,
      isTeamAdmin: false,
      isGlobalSuperuser: false,
      mountedTeamIds: [],
      insideTenantTx: false,
    }
    await tenantStore.run(ctx, () => recordUsage({ service: 's', model: 'm', tokensIn: 1, tokensOut: 0 }))
    expect(upsert.mock.calls[0]![0].where.hourUtc_service_model_actorId.actorId).toBe('user-1')
  })

  it('retries once on P2002 (concurrent first-insert race)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '7.8.0' })
    upsert.mockRejectedValueOnce(p2002).mockResolvedValueOnce({})
    await recordUsage({ service: 's', model: 'm', tokensIn: 1, tokensOut: 0 })
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('rethrows non-P2002 errors', async () => {
    upsert.mockRejectedValueOnce(new Error('boom'))
    await expect(recordUsage({ service: 's', model: 'm', tokensIn: 1, tokensOut: 0 })).rejects.toThrow('boom')
  })
})
