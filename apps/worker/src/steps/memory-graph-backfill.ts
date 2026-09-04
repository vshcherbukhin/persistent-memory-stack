/**
 * memory-graph-backfill — scheduled Graphiti retry safety net.
 *
 * Mirrors embed-backfill's contract for the graph layer: normal memory writes try
 * Graphiti inline, while this scheduled job picks up Memory rows left
 * graphStatus='pending' (missed attempt) or 'failed' (last attempt threw).
 */
import { memoryGraphEpisodeName } from '@pm/shared'
import { runInTenant, type Prisma, type Tx } from '@pm/db'
import type { WorkerDeps } from '../deps.ts'
import { withSystemTenant } from '../tenant.ts'
import { postEpisode } from './graphiti.ts'
import { deriveProjectGraphGroup } from '@pm/graph'
import { config } from '../config.ts'

const BATCH = 200
const RETRYABLE_GRAPH_STATUSES = ['pending', 'failed'] as const
const MAX_GRAPH_ERROR_LENGTH = 1000

export interface MemoryGraphBackfillRow {
  id: string
  teamId: string
  project: string
  content: string
  graphVersion: Date
  graphStatus: 'pending' | 'failed'
}

export interface MemoryGraphBackfillClient {
  postEpisode: (input: { groupId: string; name: string; episodeBody: string; referenceTime: Date }) => Promise<string>
  groupIdFor?: (row: MemoryGraphBackfillRow) => string
}

export interface MemoryGraphBackfillStats {
  scanned: number
  synced: number
  failed: number
  deletedEpisodes: number
}

export interface MemoryGraphBackfillReplayResult {
  stats: MemoryGraphBackfillStats
  syncedIds: string[]
  synced: Array<{ id: string; groupId: string; episodeId: string }>
  failed: Array<{ id: string; error: string }>
}

export function buildMemoryGraphBackfillWhere(): Prisma.MemoryWhereInput {
  return { graphStatus: { in: [...RETRYABLE_GRAPH_STATUSES] } }
}

function graphErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > MAX_GRAPH_ERROR_LENGTH ? text.slice(0, MAX_GRAPH_ERROR_LENGTH) : text
}

export async function replayMemoryGraphBackfillRows(
  rows: MemoryGraphBackfillRow[],
  client: MemoryGraphBackfillClient,
): Promise<MemoryGraphBackfillReplayResult> {
  const stats: MemoryGraphBackfillStats = { scanned: rows.length, synced: 0, failed: 0, deletedEpisodes: 0 }
  const syncedIds: string[] = []
  const synced: Array<{ id: string; groupId: string; episodeId: string }> = []
  const failed: Array<{ id: string; error: string }> = []

  for (const row of rows) {
    const name = memoryGraphEpisodeName(row.id)
    try {
      const groupId = client.groupIdFor?.(row) ?? row.teamId
      // Never remove an existing episode as part of a retry. Its historical
      // timeline remains valid provenance; hard removal is the explicit,
      // durable deletion lifecycle only.
      const episodeId = await client.postEpisode({
        groupId,
        name,
        episodeBody: row.content,
        referenceTime: row.graphVersion,
      })
      stats.synced += 1
      syncedIds.push(row.id)
      synced.push({ id: row.id, groupId, episodeId })
    } catch (err) {
      stats.failed += 1
      failed.push({ id: row.id, error: graphErrorMessage(err) })
    }
  }

  return { stats, syncedIds, synced, failed }
}

function summary(stats: MemoryGraphBackfillStats): string {
  if (stats.scanned === 0) return 'nothing pending'
  const fail = stats.failed > 0 ? `, ${stats.failed} failed` : ''
  const cap = stats.scanned === BATCH ? ' (batch cap hit — more retryable rows may remain)' : ''
  return `synced ${stats.synced} memory graph row(s)${fail} out of ${stats.scanned} scanned${cap}`
}

export async function memoryGraphBackfill(deps: WorkerDeps): Promise<string> {
  return withSystemTenant(async () => {
    const rows = await runInTenant<MemoryGraphBackfillRow[]>(
      (tx: Tx) =>
        tx.memory.findMany({
          where: buildMemoryGraphBackfillWhere(),
          orderBy: { graphVersion: 'asc' },
          take: BATCH,
          select: { id: true, teamId: true, project: true, content: true, graphVersion: true, graphStatus: true },
        }) as PromiseLike<MemoryGraphBackfillRow[]>,
      { globalAdmin: true, readOnly: true, readAllMemory: true },
    )
    if (rows.length === 0) return summary({ scanned: 0, synced: 0, failed: 0, deletedEpisodes: 0 })

    const byId = new Map(rows.map((row) => [row.id, row]))
    const result = await replayMemoryGraphBackfillRows(rows, {
      postEpisode: (input) => postEpisode(deps.graphitiUrl, deps.graphitiTimeoutMs, input),
      groupIdFor: (row) => deriveProjectGraphGroup({
        secret: config.GRAPH_GROUP_SECRET || config.TOKEN_PEPPER || 'local-development-graph-group-secret',
        teamId: row.teamId,
        project: row.project,
        surface: config.MEMORY_SURFACE ?? (config.DEPLOYMENT_MODE === 'local' ? 'personal' : 'shared'),
      }),
    })

    await runInTenant(async (tx: Tx) => {
      const syncedAt = new Date()
      for (const id of result.syncedIds) {
        const row = byId.get(id)
        const graph = result.synced.find((item) => item.id === id)
        if (!row || !graph) continue
        const updated = await tx.memory.updateMany({
          where: {
            id,
            graphVersion: row.graphVersion,
            graphStatus: { in: [...RETRYABLE_GRAPH_STATUSES] },
          },
          data: {
            graphStatus: 'ok',
            graphSyncedAt: syncedAt,
            graphError: null,
            graphGroupId: graph.groupId,
            graphEpisodeId: graph.episodeId,
          },
        })
        if (updated.count !== 1) {
          // Graphiti has already accepted this episode, but its backing row was
          // deleted or changed before we could stamp it. Never create dangling
          // provenance; queue the exact UUID for the lifecycle worker instead.
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
          continue
        }
        await tx.graphEpisodeProvenance.createMany({
          data: [{
            teamId: row.teamId,
            project: row.project,
            subjectKind: 'memory',
            subjectId: row.id,
            graphGroupId: graph.groupId,
            graphEpisodeId: graph.episodeId,
          }],
          skipDuplicates: true,
        })
      }
      for (const failed of result.failed) {
        const row = byId.get(failed.id)
        if (!row) continue
        await tx.memory.updateMany({
          where: {
            id: failed.id,
            graphVersion: row.graphVersion,
            graphStatus: { in: [...RETRYABLE_GRAPH_STATUSES] },
          },
          data: { graphStatus: 'failed', graphSyncedAt: null, graphError: failed.error },
        })
      }
    }, { globalAdmin: true })

    return summary(result.stats)
  })
}
