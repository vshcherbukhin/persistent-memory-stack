/**
 * Memory → Graphiti sync stamping.
 *
 * A memory row is the durable retry marker: create/update/import writes mark the
 * row graph-pending, then the best-effort Graphiti call flips it to ok. A failure
 * is stamped failed and remains retryable by the scheduled memory-graph-backfill.
 */
import { memoryGraphEpisodeName } from '@pm/shared'
import { randomUUID } from 'node:crypto'
import { runInTenant, type GraphStatus, type TenantRunOpts, type Tx } from '@pm/db'
import type { GraphitiClient } from './graphiti-client.ts'

const RETRYABLE_GRAPH_STATUSES = ['pending', 'failed'] satisfies GraphStatus[]
const MAX_GRAPH_ERROR_LENGTH = 1000

export interface MemoryGraphSyncRow {
  id: string
  teamId: string
  project: string
  graphGroupId: string
  content: string
  graphVersion: Date
}

export function graphSyncPendingPatch(graphVersion = new Date()): {
  graphStatus: 'pending'
  graphVersion: Date
  graphSyncedAt: null
  graphError: null
} {
  return { graphStatus: 'pending', graphVersion, graphSyncedAt: null, graphError: null }
}

export function graphSyncSuccessPatch(graph: { groupId: string; episodeId: string }, at = new Date()): {
  graphStatus: 'ok'
  graphSyncedAt: Date
  graphError: null
  graphGroupId: string
  graphEpisodeId: string
} {
  return {
    graphStatus: 'ok',
    graphSyncedAt: at,
    graphError: null,
    graphGroupId: graph.groupId,
    graphEpisodeId: graph.episodeId,
  }
}

export function graphSyncFailurePatch(err: unknown): {
  graphStatus: 'failed'
  graphSyncedAt: null
  graphError: string
} {
  return { graphStatus: 'failed', graphSyncedAt: null, graphError: graphSyncErrorMessage(err) }
}

export function graphSyncErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > MAX_GRAPH_ERROR_LENGTH ? text.slice(0, MAX_GRAPH_ERROR_LENGTH) : text
}

/** Build the one correlation key shared by a write response and Graphiti usage. */
export function memoryGraphTelemetry(row: MemoryGraphSyncRow, operationId: string = randomUUID()): {
  operationId: string
  subjectKind: 'memory'
  subjectId: string
  teamId: string
  project: string
  graphGroupId: string
  stage: string
} {
  return { operationId, subjectKind: 'memory', subjectId: row.id, teamId: row.teamId, project: row.project, graphGroupId: row.graphGroupId, stage: 'write' }
}

/**
 * An episode can be accepted after its Memory row was edited or deleted. The
 * optimistic version guard must not attach that old episode to the newer row,
 * but leaving it in Graphiti would make it searchable without provenance.
 * Queue its exact UUID for the normal durable lifecycle remover instead.
 */
export async function queueUnstampedGraphEpisodeCleanup(
  tx: Pick<Tx, 'graphLifecycleOperation'>,
  row: MemoryGraphSyncRow,
  graph: { groupId: string; episodeId: string },
): Promise<void> {
  await tx.graphLifecycleOperation.createMany({
    data: [{
      teamId: row.teamId,
      project: row.project,
      subjectKind: 'memory',
      subjectId: row.id,
      operation: 'remove',
      graphGroupId: graph.groupId,
      graphEpisodeId: graph.episodeId,
    }],
    skipDuplicates: true,
  })
}

async function stampGraphStatus(
  row: MemoryGraphSyncRow,
  data: ReturnType<typeof graphSyncSuccessPatch> | ReturnType<typeof graphSyncFailurePatch>,
  tenantOpts?: TenantRunOpts,
): Promise<number> {
  const result = await runInTenant(
    async (tx: Tx) => {
      const updated = await tx.memory.updateMany({
        where: {
          id: row.id,
          graphVersion: row.graphVersion,
          graphStatus: { in: RETRYABLE_GRAPH_STATUSES },
        },
        data,
      })
      if ('graphEpisodeId' in data) {
        if (updated.count === 1) {
          await tx.graphEpisodeProvenance.createMany({
            data: [{
              teamId: row.teamId,
              project: row.project,
              subjectKind: 'memory',
              subjectId: row.id,
              graphGroupId: data.graphGroupId,
              graphEpisodeId: data.graphEpisodeId,
            }],
            skipDuplicates: true,
          })
        } else {
          await queueUnstampedGraphEpisodeCleanup(tx, row, {
            groupId: data.graphGroupId,
            episodeId: data.graphEpisodeId,
          })
        }
      }
      return updated
    },
    tenantOpts,
  )
  return result.count
}

export async function postMemoryGraphEpisodeAndStamp(
  client: GraphitiClient,
  row: MemoryGraphSyncRow,
  tenantOpts?: TenantRunOpts,
  telemetry?: { operationId?: string },
): Promise<void> {
  try {
    const episodeId = await client.postEpisode({
      groupId: row.graphGroupId,
      name: memoryGraphEpisodeName(row.id),
      episodeBody: row.content,
      referenceTime: row.graphVersion,
      telemetry: memoryGraphTelemetry(row, telemetry?.operationId),
    })
    await stampGraphStatus(row, graphSyncSuccessPatch({ groupId: row.graphGroupId, episodeId }), tenantOpts)
  } catch (err) {
    await stampGraphStatus(row, graphSyncFailurePatch(err), tenantOpts).catch(() => {})
    throw err
  }
}
