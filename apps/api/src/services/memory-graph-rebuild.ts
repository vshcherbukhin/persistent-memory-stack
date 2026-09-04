import { randomUUID } from 'node:crypto'
import {
  enqueueMemoryGraphRebuild,
  makeIngestConnection,
  makeMemoryGraphRebuildQueue,
  type MemoryGraphRebuildFilters,
  type MemoryGraphRebuildJobData,
} from '@pm/shared'
import type { TenantCtx } from '@pm/db'
import { config } from '../config.ts'

export const memoryGraphRebuildQueue = makeMemoryGraphRebuildQueue(
  makeIngestConnection(config.REDIS_URL),
)

export interface MemoryGraphRebuildBody {
  teamId?: string
  project?: string
  createdById?: string
}

export function resolveMemoryGraphRebuildRequest(
  id: Pick<TenantCtx, 'teamId' | 'isGlobalSuperuser'>,
  body: MemoryGraphRebuildBody,
): { filters: MemoryGraphRebuildFilters } {
  const filters: MemoryGraphRebuildFilters = {}
  if (id.isGlobalSuperuser) {
    if (body.teamId) filters.teamId = body.teamId
  } else {
    if (!id.teamId) throw new Error('A team admin must belong to a team to rebuild memory graphs.')
    if (body.teamId && body.teamId !== id.teamId) {
      throw new Error('Admins may only rebuild memory graphs for their own team.')
    }
    filters.teamId = id.teamId
  }
  if (body.project) filters.project = body.project
  if (body.createdById) filters.createdById = body.createdById
  return { filters }
}

export async function enqueueResolvedMemoryGraphRebuild(input: {
  requestedById: string
  filters: MemoryGraphRebuildFilters
}): Promise<string> {
  const data: MemoryGraphRebuildJobData = {
    jobId: randomUUID(),
    requestedById: input.requestedById,
    requestedAt: new Date().toISOString(),
    filters: input.filters,
  }
  return enqueueMemoryGraphRebuild(memoryGraphRebuildQueue, data)
}
