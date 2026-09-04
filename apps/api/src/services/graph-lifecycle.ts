/**
 * Durable Graphiti lifecycle helpers.
 *
 * A Memory/Document can accumulate multiple episodes as its content evolves.
 * The current episode remains on the subject row for fast reads, while the
 * provenance table keeps every historical episode so deletion can enqueue a
 * supported UUID removal for each one.
 */
export interface GraphEpisodeReference {
  groupId: string
  episodeId: string
}

export function buildGraphDeletionPlan(input: {
  current?: GraphEpisodeReference | null
  provenance: GraphEpisodeReference[]
}): GraphEpisodeReference[] {
  const seen = new Set<string>()
  const result: GraphEpisodeReference[] = []
  for (const item of [...input.provenance, ...(input.current ? [input.current] : [])]) {
    const key = `${item.groupId}\u0000${item.episodeId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

/**
 * A project partition is a graph boundary, not a display tag. Moving a subject
 * with existing history would strand facts in its previous project unless we
 * replay every historical episode transactionally, which is intentionally not
 * an implicit edit operation.
 */
export function assertProjectMovePreservesGraphBoundary(input: {
  currentProject: string
  nextProject: string
  hasGraphHistory: boolean
}): void {
  if (input.currentProject !== input.nextProject && input.hasGraphHistory) {
    throw new Error('Project history is immutable after graph sync. Create a new memory in the target project instead.')
  }
}

export async function enqueueGraphRemoval(
  tx: import('@pm/db').Tx,
  input: {
    teamId: string
    project: string
    subjectKind: 'memory' | 'document'
    subjectId: string
    current?: GraphEpisodeReference | null
  },
): Promise<GraphEpisodeReference[]> {
  const episodes = await graphDeletionPlanForSubject(tx, input)
  if (episodes.length > 0) {
    await tx.graphLifecycleOperation.createMany({
      data: episodes.map((episode) => ({
        teamId: input.teamId,
        project: input.project,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        operation: 'remove',
        graphGroupId: episode.groupId,
        graphEpisodeId: episode.episodeId,
      })),
      skipDuplicates: true,
    })
  }
  return episodes
}

export async function graphDeletionPlanForSubject(
  tx: import('@pm/db').Tx,
  input: {
    subjectKind: 'memory' | 'document'
    subjectId: string
    current?: GraphEpisodeReference | null
  },
): Promise<GraphEpisodeReference[]> {
  const provenance = await tx.graphEpisodeProvenance.findMany({
    where: { subjectKind: input.subjectKind, subjectId: input.subjectId },
    // The preview token is compared on confirmation. Keep the episode plan
    // deterministic so a harmless re-read cannot invalidate a live preview.
    orderBy: { createdAt: 'asc' },
    select: { graphGroupId: true, graphEpisodeId: true },
  })
  return buildGraphDeletionPlan({
    current: input.current,
    provenance: provenance.map((row) => ({ groupId: row.graphGroupId, episodeId: row.graphEpisodeId })),
  })
}
