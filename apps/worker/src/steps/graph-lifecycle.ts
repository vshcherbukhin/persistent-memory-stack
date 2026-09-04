import { runInTenant, type Tx } from '@pm/db'
import type { WorkerDeps } from '../deps.ts'
import { withSystemTenant } from '../tenant.ts'
import { GraphitiClient } from '@pm/graph'

const BATCH = 100
const MAX_ERROR_LENGTH = 1000
const STALE_PROCESSING_MS = 5 * 60 * 1000

export interface GraphLifecycleOperationRow {
  id: string
  operation: 'remove' | 'replace'
  subjectKind: 'memory' | 'document'
  subjectId: string
  teamId: string
  project: string
  graphGroupId: string
  graphEpisodeId: string
}

export interface GraphLifecycleClient {
  removeEpisode: (groupId: string, episodeId: string) => Promise<number>
  episodeImpact: (groupId: string, episodeIds: string[]) => Promise<Array<{ episode_uuid: string; exists: boolean }>>
  postEpisode: (input: { groupId: string; name: string; episodeBody: string; referenceTime: Date; idempotencyKey?: string }) => Promise<string>
}

export async function replayGraphLifecycleOperations(
  rows: GraphLifecycleOperationRow[],
  client: GraphLifecycleClient,
): Promise<{ completedIds: string[]; failed: Array<{ id: string; error: string }> }> {
  const completedIds: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const row of rows) {
    try {
      await client.removeEpisode(row.graphGroupId, row.graphEpisodeId)
      const impacts = await client.episodeImpact(row.graphGroupId, [row.graphEpisodeId])
      if (impacts.some((impact) => impact.episode_uuid === row.graphEpisodeId && impact.exists)) {
        throw new Error('Graphiti still reports the removed episode as present.')
      }
      completedIds.push(row.id)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      failed.push({ id: row.id, error: text.slice(0, MAX_ERROR_LENGTH) })
    }
  }
  return { completedIds, failed }
}

export async function graphLifecycle(deps: WorkerDeps): Promise<string> {
  return withSystemTenant(async () => {
    const rows = await runInTenant<GraphLifecycleOperationRow[]>(
      (tx: Tx) => tx.graphLifecycleOperation.findMany({
        where: {
          operation: { in: ['remove', 'replace'] },
          OR: [
            { status: { in: ['pending', 'failed'] } },
            { status: 'processing', updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
          ],
        },
        orderBy: { requestedAt: 'asc' },
        take: BATCH,
        select: { id: true, operation: true, subjectKind: true, subjectId: true, teamId: true, project: true, graphGroupId: true, graphEpisodeId: true },
      }) as PromiseLike<GraphLifecycleOperationRow[]>,
      { globalAdmin: true, readOnly: true },
    )
    if (rows.length === 0) return 'no pending graph lifecycle operations'

    await runInTenant(
      (tx: Tx) => tx.graphLifecycleOperation.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: { in: ['pending', 'failed'] } },
        data: { status: 'processing', attempts: { increment: 1 }, lastError: null },
      }),
      { globalAdmin: true },
    )
    const client = new GraphitiClient(deps.graphitiUrl, deps.graphitiTimeoutMs)
    const result = await replayGraphLifecycleOperations(rows.filter((row) => row.operation === 'remove'), {
      removeEpisode: (groupId, episodeId) => client.removeEpisode({ groupId, episodeId }),
      episodeImpact: (groupId, episodeIds) => client.episodeImpact({ groupId, episodeIds }),
      postEpisode: (input) => client.postEpisode(input),
    })
    const replacementFailures: Array<{ id: string; error: string }> = []
    const replacementCompleted: string[] = []
    for (const row of rows.filter((item) => item.operation === 'replace' && item.subjectKind === 'document')) {
      try {
        const chunks = await runInTenant((tx: Tx) => tx.chunk.findMany({ where: { documentId: row.subjectId }, orderBy: { ordinal: 'asc' }, select: { content: true } }), { globalAdmin: true, readOnly: true })
        if (chunks.length === 0) throw new Error('Document chunks no longer exist; retry episode is no longer applicable.')
        const episodeId = await client.postEpisode({ groupId: row.graphGroupId, name: `doc:${row.subjectId}`, episodeBody: chunks.map((chunk) => chunk.content).join('\n\n'), referenceTime: new Date(), idempotencyKey: row.graphEpisodeId })
        try {
          // The current pointer and immutable provenance must commit together.
          // If they cannot, compensate immediately with the exact UUID we just
          // received—never retry a blind second add_episode over an orphan.
          await runInTenant(async (tx: Tx) => {
            await tx.document.update({ where: { id: row.subjectId }, data: { graphGroupId: row.graphGroupId, graphEpisodeId: episodeId } })
            await tx.graphEpisodeProvenance.createMany({ data: [{ teamId: row.teamId, project: row.project, subjectKind: 'document', subjectId: row.subjectId, graphGroupId: row.graphGroupId, graphEpisodeId: episodeId }], skipDuplicates: true })
          }, { globalAdmin: true })
        } catch (stampError) {
          try {
            await client.removeEpisode({ groupId: row.graphGroupId, episodeId })
          } catch (compensationError) {
            const stamp = stampError instanceof Error ? stampError.message : String(stampError)
            const compensation = compensationError instanceof Error ? compensationError.message : String(compensationError)
            throw new Error(`Episode provenance stamp failed (${stamp}); compensating removal also failed (${compensation}).`)
          }
          throw stampError
        }
        replacementCompleted.push(row.id)
      } catch (err) {
        replacementFailures.push({ id: row.id, error: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH) })
      }
    }
    const completedAt = new Date()
    await runInTenant(async (tx: Tx) => {
      const completedIds = [...result.completedIds, ...replacementCompleted]
      if (completedIds.length > 0) {
        await tx.graphLifecycleOperation.updateMany({
          where: { id: { in: completedIds } },
          data: { status: 'completed', completedAt, lastError: null },
        })
      }
      for (const failure of [...result.failed, ...replacementFailures]) {
        await tx.graphLifecycleOperation.updateMany({
          where: { id: failure.id },
          data: { status: 'failed', lastError: failure.error },
        })
      }
    }, { globalAdmin: true })
    return `processed ${rows.length} graph lifecycle operation(s): ${result.completedIds.length + replacementCompleted.length} completed, ${result.failed.length + replacementFailures.length} retryable failure(s)`
  })
}
