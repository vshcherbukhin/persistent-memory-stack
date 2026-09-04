/**
 * One-shot installer migration for the project-scoped Graph V2 partitions.
 *
 * It is intentionally run by the updater after its protected snapshot and after
 * Prisma/RLS are current. The run record makes retries safe: posts use a stable
 * idempotency key, validation happens before legacy cleanup, and a failed run is
 * resumed from PostgreSQL rather than guessing from the graph.
 */
import { ownerPrisma, runInTenant, type Tx } from '@pm/db'
import { deriveProjectGraphGroup, GraphitiClient } from '@pm/graph'
import { memoryGraphEpisodeName } from '@pm/shared'
import { randomUUID } from 'node:crypto'
import { withSystemTenant } from '../tenant.ts'

export const GRAPH_V2_MIGRATION_VERSION = 'graph-v2-project-partitions-1'
const BATCH = 100
const V2_GROUP_PREFIX = 'pmg2_'
const MAX_REBUILD_RESCANS = 3

export type PersistedGraphMigrationState = 'snapshot_confirmed' | 'v2_rebuild_running' | 'v2_rebuild_validating' | 'legacy_cleanup_running' | 'complete' | 'failed'

export interface GraphMigrationValidation {
  memories: { total: number; v2Complete: number }
  missingProvenance: number
  pendingRemovals: number
  deletedEpisodesStillPresent: number
  legacyGroups: number
}

export function nextGraphMigrationState(state: PersistedGraphMigrationState, ok: boolean): PersistedGraphMigrationState {
  if (!ok) return 'failed'
  if (state === 'snapshot_confirmed' || state === 'failed') return 'v2_rebuild_running'
  if (state === 'v2_rebuild_running') return 'v2_rebuild_validating'
  if (state === 'v2_rebuild_validating') return 'legacy_cleanup_running'
  if (state === 'legacy_cleanup_running') return 'complete'
  return 'complete'
}

export function validateGraphMigration(input: GraphMigrationValidation): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  const incomplete = input.memories.total - input.memories.v2Complete
  if (incomplete > 0) reasons.push(`${incomplete} live memory row(s) have no v2 provenance.`)
  if (input.missingProvenance > 0) reasons.push(`${input.missingProvenance} provenance record(s) are missing.`)
  if (input.pendingRemovals > 0) reasons.push(`${input.pendingRemovals} graph removal(s) are still pending.`)
  if (input.deletedEpisodesStillPresent > 0) reasons.push(`${input.deletedEpisodesStillPresent} deleted episode(s) remain searchable.`)
  return { ok: reasons.length === 0, reasons }
}

/**
 * A validation miss immediately after a replay can only be resolved by replaying
 * again: a row may have been created or changed while the first cursor was
 * advancing.  Other validation failures need operator attention rather than
 * repeatedly posting the same graph episodes.
 */
export function shouldRetryGraphMigrationRebuild(input: GraphMigrationValidation): boolean {
  return input.memories.v2Complete < input.memories.total || input.missingProvenance > 0
}

/**
 * V1 used the team id as its graph group.  Retain that target even after a row
 * has been stamped with its V2 pointer, otherwise a failed/restarted migration
 * would lose the only record of the unread V1 group that still needs cleanup.
 */
export function legacyGraphGroupsForRows(rows: Array<Pick<ReplayRow, 'teamId' | 'graphGroupId'>>): string[] {
  const groups = new Set<string>()
  for (const row of rows) {
    groups.add(row.teamId)
    if (row.graphGroupId && !row.graphGroupId.startsWith(V2_GROUP_PREFIX)) groups.add(row.graphGroupId)
  }
  return [...groups]
}

type ReplayRow = { id: string; teamId: string; project: string; content: string; graphVersion: Date; graphStatus: string; graphGroupId: string | null; graphEpisodeId: string | null }
type GraphProgressRow = Pick<ReplayRow, 'teamId' | 'project' | 'graphGroupId' | 'graphEpisodeId'> & { graphStatus: string }

export interface GraphV2MigrationDeps {
  graphiti: Pick<GraphitiClient, 'postEpisode' | 'episodeImpact' | 'purgeGroup'>
  groupSecret: string
  surface: 'personal' | 'shared'
  snapshotId: string
}

function graphGroup(row: Pick<ReplayRow, 'teamId' | 'project'>, deps: GraphV2MigrationDeps): string {
  return deriveProjectGraphGroup({ secret: deps.groupSecret, teamId: row.teamId, project: row.project, surface: deps.surface })
}

/** One shared completion predicate for validation and updater progress reporting. */
export function isGraphV2Complete(row: GraphProgressRow, deps: GraphV2MigrationDeps): boolean {
  return row.graphStatus === 'ok' && row.graphEpisodeId !== null && row.graphGroupId === graphGroup(row, deps)
}

export interface GraphV2Progress {
  completed: number
  total: number
  state: string
}

/**
 * Read-only progress snapshot for the updater. It deliberately uses the same
 * opaque-partition predicate as validation so V1 team-wide pointers never make
 * the dashboard look complete before the rebuild actually is.
 */
export async function inspectGraphV2Progress(deps: GraphV2MigrationDeps): Promise<GraphV2Progress> {
  return withSystemTenant(async () => {
    const [rows, run] = await Promise.all([
      runInTenant<GraphProgressRow[]>(
        (tx: Tx) => tx.memory.findMany({
          select: { teamId: true, project: true, graphStatus: true, graphGroupId: true, graphEpisodeId: true },
        }) as PromiseLike<GraphProgressRow[]>,
        { globalAdmin: true, readOnly: true, readAllMemory: true },
      ),
      ownerPrisma.graphMigrationRun.findUnique({ where: { version: GRAPH_V2_MIGRATION_VERSION }, select: { state: true } }),
    ])
    return {
      completed: rows.filter((row) => isGraphV2Complete(row, deps)).length,
      total: rows.length,
      state: run?.state ?? 'starting',
    }
  })
}

async function rebuildMemories(deps: GraphV2MigrationDeps): Promise<{ rebuilt: number; legacyGroups: string[] }> {
  let cursor: string | undefined
  let rebuilt = 0
  const legacyGroups = new Set<string>()
  for (;;) {
    const rows = await runInTenant<ReplayRow[]>(
      (tx: Tx) => tx.memory.findMany({
        where: cursor ? { id: { gt: cursor } } : {}, orderBy: { id: 'asc' }, take: BATCH,
        select: { id: true, teamId: true, project: true, content: true, graphVersion: true, graphStatus: true, graphGroupId: true, graphEpisodeId: true },
      }) as PromiseLike<ReplayRow[]>,
      { globalAdmin: true, readOnly: true, readAllMemory: true },
    )
    if (rows.length === 0) break
    for (const row of rows) {
      const groupId = graphGroup(row, deps)
      for (const legacyGroup of legacyGraphGroupsForRows([row])) legacyGroups.add(legacyGroup)
      const episodeId = await deps.graphiti.postEpisode({
        groupId, name: memoryGraphEpisodeName(row.id), episodeBody: row.content, referenceTime: row.graphVersion,
        idempotencyKey: memoryGraphEpisodeName(row.id),
        telemetry: { operationId: randomUUID(), subjectKind: 'memory', subjectId: row.id, teamId: row.teamId, project: row.project, graphGroupId: groupId, stage: 'installer-rebuild' },
      })
      await runInTenant(async (tx: Tx) => {
        const updated = await tx.memory.updateMany({
          where: { id: row.id, graphVersion: row.graphVersion },
          data: { graphStatus: 'ok', graphSyncedAt: new Date(), graphError: null, graphGroupId: groupId, graphEpisodeId: episodeId },
        })
        if (updated.count === 1) {
          await tx.graphEpisodeProvenance.createMany({
            data: [{ teamId: row.teamId, project: row.project, subjectKind: 'memory', subjectId: row.id, graphGroupId: groupId, graphEpisodeId: episodeId }],
            skipDuplicates: true,
          })
          rebuilt += 1
        }
      }, { globalAdmin: true })
    }
    cursor = rows.at(-1)!.id
    if (rows.length < BATCH) break
  }
  return { rebuilt, legacyGroups: [...legacyGroups] }
}

async function inspectValidation(deps: GraphV2MigrationDeps, legacyGroups: string[]): Promise<GraphMigrationValidation> {
  const rows = await runInTenant<ReplayRow[]>(
    (tx: Tx) => tx.memory.findMany({ select: { id: true, teamId: true, project: true, content: true, graphVersion: true, graphStatus: true, graphGroupId: true, graphEpisodeId: true } }) as PromiseLike<ReplayRow[]>,
    { globalAdmin: true, readOnly: true, readAllMemory: true },
  )
  const complete = rows.filter((row) => isGraphV2Complete(row, deps)).length
  const [provenance, pendingRemovals, completedRemovals] = await runInTenant(async (tx: Tx) => Promise.all([
    tx.graphEpisodeProvenance.findMany({ where: { subjectKind: 'memory' }, select: { subjectId: true, graphGroupId: true, graphEpisodeId: true } }),
    tx.graphLifecycleOperation.count({ where: { status: { in: ['pending', 'processing', 'failed'] } } }),
    tx.graphLifecycleOperation.findMany({ where: { operation: 'remove', status: 'completed' }, take: 200, select: { graphGroupId: true, graphEpisodeId: true } }),
  ]), { globalAdmin: true, readOnly: true })
  const provenanceKeys = new Set(provenance.map((item) => `${item.subjectId}:${item.graphGroupId}:${item.graphEpisodeId}`))
  const missingProvenance = rows.filter((row) => !row.graphGroupId || !row.graphEpisodeId || !provenanceKeys.has(`${row.id}:${row.graphGroupId}:${row.graphEpisodeId}`)).length
  let deletedEpisodesStillPresent = 0
  for (const removal of completedRemovals) {
    const impact = await deps.graphiti.episodeImpact({ groupId: removal.graphGroupId, episodeIds: [removal.graphEpisodeId] })
    if (impact.some((item) => item.exists)) deletedEpisodesStillPresent += 1
  }
  return { memories: { total: rows.length, v2Complete: complete }, missingProvenance, pendingRemovals, deletedEpisodesStillPresent, legacyGroups: legacyGroups.length }
}

export async function runGraphV2Migration(deps: GraphV2MigrationDeps): Promise<{ state: PersistedGraphMigrationState; metrics: Record<string, unknown> }> {
  if (deps.surface !== 'personal') return { state: 'complete', metrics: { skipped: 'shared surface' } }
  return withSystemTenant(async () => {
    let run = await ownerPrisma.graphMigrationRun.upsert({
      where: { version: GRAPH_V2_MIGRATION_VERSION },
      create: { version: GRAPH_V2_MIGRATION_VERSION, state: 'snapshot_confirmed', snapshotId: deps.snapshotId },
      update: { snapshotId: deps.snapshotId },
    })
    if (run.state === 'complete') return { state: 'complete', metrics: (run.metrics as Record<string, unknown>) ?? {} }

    run = await ownerPrisma.graphMigrationRun.update({ where: { id: run.id }, data: { state: 'v2_rebuild_running', lastError: null } })
    let rebuilt = 0
    const legacyGroups = new Set<string>()
    let validation: GraphMigrationValidation | undefined
    for (let pass = 1; pass <= MAX_REBUILD_RESCANS; pass += 1) {
      const replay = await rebuildMemories(deps)
      rebuilt += replay.rebuilt
      replay.legacyGroups.forEach((group) => legacyGroups.add(group))
      await ownerPrisma.graphMigrationRun.update({
        where: { id: run.id },
        data: { state: 'v2_rebuild_validating', metrics: { rebuilt, rebuildPasses: pass, legacyGroups: [...legacyGroups] } },
      })
      validation = await inspectValidation(deps, [...legacyGroups])
      if (!shouldRetryGraphMigrationRebuild(validation)) break
    }
    if (!validation) throw new Error('Graph V2 migration did not run a validation pass.')
    const verdict = validateGraphMigration(validation)
    if (!verdict.ok) {
      await ownerPrisma.graphMigrationRun.update({ where: { id: run.id }, data: { state: 'failed', lastError: verdict.reasons.join(' '), metrics: validation as object } })
      throw new Error(`Graph V2 validation failed: ${verdict.reasons.join(' ')}`)
    }
    await ownerPrisma.graphMigrationRun.update({ where: { id: run.id }, data: { state: 'legacy_cleanup_running', metrics: validation as object } })
    for (const legacyGroup of legacyGroups) {
      const remaining = await deps.graphiti.purgeGroup({ groupId: legacyGroup })
      if (remaining.episodes !== 0 || remaining.facts !== 0) throw new Error(`Legacy group ${legacyGroup} was not empty after cleanup.`)
    }
    const metrics = { ...validation, rebuilt, cleanedLegacyGroups: legacyGroups.size }
    await ownerPrisma.graphMigrationRun.update({ where: { id: run.id }, data: { state: 'complete', metrics, completedAt: new Date(), lastError: null } })
    return { state: 'complete', metrics }
  })
}
