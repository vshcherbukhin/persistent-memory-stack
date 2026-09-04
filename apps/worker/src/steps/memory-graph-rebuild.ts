/**
 * One-time Memory → Graphiti rebuild.
 *
 * This backs the dashboard Memory Tools action. It is not a scheduled sweep: an
 * operator chooses team/project/author filters, the API enqueues one job, and the
 * worker replays matching Memory rows through the same Graphiti episode contract
 * used by live memory writes.
 */
import { memoryGraphEpisodeName, type MemoryGraphRebuildFilters, type MemoryGraphRebuildJobData, type MemoryGraphRebuildJobResult } from '@pm/shared'
import { runInTenant, type Prisma, type Tx } from '@pm/db'
import type { WorkerDeps } from '../deps.ts'
import { withSystemTenant } from '../tenant.ts'
import { postEpisode } from './graphiti.ts'
import { deriveProjectGraphGroup } from '@pm/graph'
import { config } from '../config.ts'

const BATCH = 100

export interface MemoryGraphReplayRow {
  id: string
  teamId: string
  project: string
  content: string
  graphVersion: Date
}

export interface MemoryGraphReplayClient {
  postEpisode: (input: { groupId: string; name: string; episodeBody: string; referenceTime: Date }) => Promise<string>
  groupIdFor?: (row: MemoryGraphReplayRow) => string
}

export interface MemoryGraphReplayStats {
  scanned: number
  rebuilt: number
  failed: number
  deletedEpisodes: number
  synced: Array<{ id: string; groupId: string; episodeId: string }>
}

export function buildMemoryGraphWhere(filters: MemoryGraphRebuildFilters): Prisma.MemoryWhereInput {
  return {
    ...(filters.teamId ? { teamId: filters.teamId } : {}),
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.createdById ? { createdById: filters.createdById } : {}),
  }
}

export async function replayMemoryGraphRows(
  rows: MemoryGraphReplayRow[],
  client: MemoryGraphReplayClient,
): Promise<MemoryGraphReplayStats> {
  const stats: MemoryGraphReplayStats = { scanned: rows.length, rebuilt: 0, failed: 0, deletedEpisodes: 0, synced: [] }
  for (const row of rows) {
    const name = memoryGraphEpisodeName(row.id)
    try {
      const groupId = client.groupIdFor?.(row) ?? row.teamId
      // A rebuild adds authoritative historical evidence. It must not use a
      // name-based delete, which could erase the graph-primary episode.
      const episodeId = await client.postEpisode({
        groupId,
        name,
        episodeBody: row.content,
        referenceTime: row.graphVersion,
      })
      stats.rebuilt += 1
      stats.synced.push({ id: row.id, groupId, episodeId })
    } catch {
      stats.failed += 1
    }
  }
  return stats
}

function addStats(a: MemoryGraphReplayStats, b: MemoryGraphReplayStats): MemoryGraphReplayStats {
  return {
    scanned: a.scanned + b.scanned,
    rebuilt: a.rebuilt + b.rebuilt,
    failed: a.failed + b.failed,
    deletedEpisodes: a.deletedEpisodes + b.deletedEpisodes,
    synced: [...a.synced, ...b.synced],
  }
}

function summary(stats: MemoryGraphReplayStats): string {
  if (stats.scanned === 0) return 'no memories matched the graph rebuild filters'
  const fail = stats.failed > 0 ? `, ${stats.failed} failed` : ''
  return `rebuilt ${stats.rebuilt} memory graph episode(s)${fail} out of ${stats.scanned} scanned`
}

export async function memoryGraphRebuild(
  deps: WorkerDeps,
  data: MemoryGraphRebuildJobData,
): Promise<MemoryGraphRebuildJobResult> {
  return withSystemTenant(async () => {
    let cursor: string | undefined
    let total: MemoryGraphReplayStats = { scanned: 0, rebuilt: 0, failed: 0, deletedEpisodes: 0, synced: [] }
    const where = buildMemoryGraphWhere(data.filters)
    const client: MemoryGraphReplayClient = {
      postEpisode: (input) => postEpisode(deps.graphitiUrl, deps.graphitiTimeoutMs, input),
      groupIdFor: (row) => deriveProjectGraphGroup({
        secret: config.GRAPH_GROUP_SECRET || config.TOKEN_PEPPER || 'local-development-graph-group-secret',
        teamId: row.teamId,
        project: row.project,
        surface: config.MEMORY_SURFACE ?? (config.DEPLOYMENT_MODE === 'local' ? 'personal' : 'shared'),
      }),
    }

    for (;;) {
      const rows = await runInTenant<MemoryGraphReplayRow[]>(
        (tx: Tx) =>
          tx.memory.findMany({
            where: {
              ...where,
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: 'asc' },
            take: BATCH,
            select: { id: true, teamId: true, project: true, content: true, graphVersion: true },
          }) as PromiseLike<MemoryGraphReplayRow[]>,
        { globalAdmin: true, readOnly: true, readAllMemory: true },
      )
      if (rows.length === 0) break
      const replay = await replayMemoryGraphRows(rows, client)
      total = addStats(total, replay)
      await runInTenant(async (tx: Tx) => {
        for (const graph of replay.synced) {
          const row = rows.find((candidate) => candidate.id === graph.id)
          if (!row) continue
          const updated = await tx.memory.updateMany({
            where: { id: row.id, graphVersion: row.graphVersion },
            data: { graphStatus: 'ok', graphSyncedAt: new Date(), graphError: null, graphGroupId: graph.groupId, graphEpisodeId: graph.episodeId },
          })
          if (updated.count !== 1) {
            // The post succeeded, but this exact Memory version no longer exists.
            // Preserve no dangling provenance; let the durable lifecycle worker
            // remove the exact externally-created Graphiti episode.
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
            data: [{ teamId: row.teamId, project: row.project, subjectKind: 'memory', subjectId: row.id, graphGroupId: graph.groupId, graphEpisodeId: graph.episodeId }],
            skipDuplicates: true,
          })
        }
      }, { globalAdmin: true })
      cursor = rows[rows.length - 1]!.id
      if (rows.length < BATCH) break
    }

    const text = summary(total)
    return { ...total, summary: text }
  })
}
