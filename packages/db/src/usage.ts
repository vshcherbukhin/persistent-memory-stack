/**
 * @pm/db — model-usage recorder. Writes the hourly `model_usage_rollup` control
 * table via ownerPrisma (no RLS; owner-only). Call sites use the fire-and-forget
 * wrapper so recording NEVER blocks or fails a request.
 */
import { ownerPrisma } from './prisma.ts'
import { tenantStore } from './tenant-context.ts'
import { Prisma } from '../../../generated/prisma/client.ts'

export interface UsageEvent {
  /** 'fact-extraction' | 'graphiti' | 'embeddings' */
  service: string
  model: string
  tokensIn: number
  tokensOut: number
  /** Optional override; omitted means infer from current tenant context if any. */
  userId?: string | null
}

/** Floor a Date to the start of its UTC hour (the rollup bucket key). Pure. */
export function currentHourBucket(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0),
  )
}

/**
 * Increment the current-hour bucket for (service, model). The `update` increments
 * are atomic server-side; only the FIRST insert per bucket can race two concurrent
 * upserts into a P2002 — caught + retried once (the row then exists, so the retry
 * takes the atomic update path).
 */
export async function recordUsage(e: UsageEvent, now: Date = new Date()): Promise<void> {
  const hourUtc = currentHourBucket(now)
  const actorId = e.userId ?? tenantStore.getStore()?.userId ?? 'system'
  const safeActorId = actorId.trim() === '' ? 'system' : actorId
  const where = { hourUtc_service_model_actorId: { hourUtc, service: e.service, model: e.model, actorId: safeActorId } }
  const create = {
    hourUtc, service: e.service, model: e.model, actorId: safeActorId,
    tokensIn: BigInt(e.tokensIn), tokensOut: BigInt(e.tokensOut), requests: 1,
  }
  const update = {
    tokensIn: { increment: BigInt(e.tokensIn) },
    tokensOut: { increment: BigInt(e.tokensOut) },
    requests: { increment: 1 },
  }
  try {
    await ownerPrisma.modelUsageRollup.upsert({ where, create, update })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await ownerPrisma.modelUsageRollup.upsert({ where, create, update }) // retry → update path
    } else {
      throw err
    }
  }
}

/** Record without awaiting — recording failure must never surface to the caller. */
export function recordUsageFireAndForget(e: UsageEvent): void {
  void recordUsage(e).catch((err) => {
    console.warn('[usage] recordUsage failed:', err instanceof Error ? err.message : String(err))
  })
}
