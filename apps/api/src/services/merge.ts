/** Personal-space hybrid retrieval. Postgres is authoritative for ownership, filters and revisions. */
import type { QdrantClient } from '@pm/shared/qdrant'
import { searchVectors, type ActivePin, type KnowledgeFilter } from '@pm/shared'
import { Prisma, runInTenant, getCtx, type Tx } from '@pm/db'
import { knowledgeWhere } from './knowledge.ts'

export interface MergeArgs extends KnowledgeFilter {
  queryVector?: number[]; query?: string; pin: ActivePin; category?: string;
  scoreMin?: number; scoreMax?: number; limit: number; universal?: boolean;
  contextHints?: { projects?: string[]; topics?: string[] }
}
export interface MergedMemory {
  id: string; content: string; category: string; shape: string; entities: string[];
  project: string; sessionId: string | null; createdById: string | null; score: number;
  sourceTeam: string; isOwnTeam: boolean; createdAt: string; recordUpdatedAt: string;
  memoryTier: string; sourceProvenance: string; confidence: number; revision: number;
  classification: unknown; classificationStatus: string; embeddingStatus: string; graphStatus: string;
  relationshipExplanations: string[];
}
export interface MergeResult { results: MergedMemory[]; counts: { own: number; other: number }; diagnostics: { semantic: string; lexical: string; graphExpansion: string } }

export async function reinforceMemoryAccess(tx: Pick<Tx, '$executeRaw'>, ids: string[], at = new Date()): Promise<void> {
  if (!ids.length) return
  const values = Prisma.join(ids.map(id => Prisma.sql`${id}`))
  await tx.$executeRaw(Prisma.sql`UPDATE memory SET last_accessed_at = ${at}, access_count = access_count + 1 WHERE id IN (${values})`)
}
export function buildMemoryHydrateWhere(rowIds: string[], args: MergeArgs): Prisma.MemoryWhereInput {
  return { ...knowledgeWhere(args), id: { in: rowIds },
    ...(args.category ? { category: args.category } : {}),
    ...(args.scoreMin !== undefined || args.scoreMax !== undefined ? { confidence: { gte: args.scoreMin, lte: args.scoreMax } } : {}),
  }
}

export async function searchMemoriesMerged(client: QdrantClient, args: MergeArgs): Promise<MergeResult> {
  knowledgeWhere(args) // Enforce the complete relational filter contract before any index/database access.
  const teamId = getCtx().teamId
  if (!teamId) throw new Error('Personal owner is required for retrieval.')
  const diagnostics = { semantic: args.queryVector ? 'available' : 'unavailable', lexical: args.query ? 'available' : 'not_requested', graphExpansion: 'resolved_topics' }
  let hits: Awaited<ReturnType<typeof searchVectors>> = []
  if (args.queryVector) {
    try {
      hits = await searchVectors(client, { queryVector: args.queryVector, pin: args.pin, readableTeamIds: [teamId], ...(args.project ? { project: args.project } : {}), ...(args.projects ? { projects: args.projects } : {}), sourceKind: 'memory', limit: Math.min(200, Math.max(args.limit * 4, 40)) })
    } catch { diagnostics.semantic = 'unavailable' }
  }
  return runInTenant(async (tx: Tx) => {
    const terms = [...new Set((args.query ?? '').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 12)
    const scope: Prisma.Sql[] = [Prisma.sql`ownership_state = 'personal'`, Prisma.sql`deleted_at IS NULL`]
    const projects = args.projects ?? (args.project ? [args.project] : [])
    if (projects.length) scope.push(Prisma.sql`(project = ANY(ARRAY[${Prisma.join(projects)}]::TEXT[]) OR project_associations && ARRAY[${Prisma.join(projects)}]::TEXT[])`)
    if (args.topic) scope.push(Prisma.sql`${args.topic} = ANY(topic_tags)`)
    if (args.memoryType) scope.push(Prisma.sql`memory_type = ${args.memoryType}`)
    if (args.assertionStatus) scope.push(Prisma.sql`assertion_status = ${args.assertionStatus}`)
    if (args.createdAfter) scope.push(Prisma.sql`created_at >= ${new Date(args.createdAfter)}`)
    if (args.createdBefore) scope.push(Prisma.sql`created_at <= ${new Date(args.createdBefore)}`)
    if (args.category) scope.push(Prisma.sql`category = ${args.category}`)
    // Parameterized FTS works for legacy rows without requiring a vector rewrite.
    const lexicalIds = terms.length ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM memory WHERE ${Prisma.join(scope, ' AND ')}
      AND to_tsvector('simple', content) @@ to_tsquery('simple', ${terms.map(term => "'" + term.replaceAll("'", "''") + "'").join(' & ')})
      ORDER BY ts_rank_cd(to_tsvector('simple', content), to_tsquery('simple', ${terms.map(term => "'" + term.replaceAll("'", "''") + "'").join(' & ')})) DESC, id LIMIT 200
    `) : []
    const rowIds = [...new Set([...hits.map(hit => hit.rowId), ...lexicalIds.map(row => row.id)])]
    if (!rowIds.length) return { results: [], counts: { own: 0, other: 0 }, diagnostics }
    const rows = await tx.memory.findMany({ where: buildMemoryHydrateWhere(rowIds, args) })
    const scores = new Map<string, number>()
    const reasons = new Map<string, string[]>()
    for (const row of rows) {
      const vectorRank = hits.findIndex(hit => hit.rowId === row.id && hit.teamId === teamId && row.embeddingStatus === 'embedded' &&
        (hit.revision === row.revision || (hit.revision === undefined && row.revision === 1 && row.knowledge === null)))
      const lexicalRank = lexicalIds.findIndex(hit => hit.id === row.id)
      const lexicalCoverage = terms.filter(term => row.content.toLowerCase().includes(term)).length / Math.max(1, terms.length)
      const score = (vectorRank < 0 ? 0 : 1 / (20 + vectorRank)) + (lexicalRank < 0 || lexicalCoverage < 0.5 ? 0 : (0.5 + lexicalCoverage) / (20 + lexicalRank))
      if (score > 0) scores.set(row.id, score)
      reasons.set(row.id, [...(vectorRank < 0 ? [] : ['Semantic candidate at the current record revision.']), ...(lexicalRank < 0 ? [] : ['Exact/lexical source-text match.'])])
    }
    const seedTopics = [...new Set(rows.filter(row => scores.has(row.id)).sort((a,b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, 5).flatMap(row => row.topicTags))].slice(0, 6)
    const connected = seedTopics.length ? await tx.memory.findMany({ where: { AND: [knowledgeWhere(args), { topicTags: { hasSome: seedTopics } }] }, take: 40, orderBy: [{ recordUpdatedAt: 'desc' }, { id: 'asc' }] }) : []
    const all = new Map(rows.filter(row => scores.has(row.id)).map(row => [row.id, row]))
    for (const row of connected) {
      const topics = row.topicTags.filter(topic => seedTopics.includes(topic))
      if (!scores.has(row.id)) scores.set(row.id, 0.012)
      reasons.set(row.id, [...reasons.get(row.id) ?? [], `ABOUT resolved topic(s): ${topics.join(', ')}. This explains relevance, not factual equivalence.`])
      all.set(row.id, row)
    }
    const results = [...all.values()].map(row => {
      const hint = (args.contextHints?.projects?.some(project => row.projectAssociations.includes(project) || row.project === project) ? 0.002 : 0) + (args.contextHints?.topics?.some(topic => row.topicTags.includes(topic)) ? 0.002 : 0)
      return { id: row.id, content: row.content, category: row.category, shape: row.shape, entities: row.entities, project: row.project,
        sessionId: row.sessionId, createdById: row.createdById, score: (scores.get(row.id) ?? 0) + hint, sourceTeam: row.teamId, isOwnTeam: true,
        createdAt: row.createdAt.toISOString(), recordUpdatedAt: row.recordUpdatedAt.toISOString(), memoryTier: row.memoryTier, sourceProvenance: row.sourceProvenance,
        confidence: row.confidence, revision: row.revision, classification: row.knowledge, classificationStatus: row.knowledge ? 'classified' : 'legacy_unclassified',
        embeddingStatus: row.embeddingStatus, graphStatus: row.knowledge ? row.graphStatus : 'legacy_preserved', relationshipExplanations: reasons.get(row.id) ?? [] }
    }).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, args.limit)
    await reinforceMemoryAccess(tx, results.map(row => row.id))
    return { results, counts: { own: results.length, other: 0 }, diagnostics }
  })
}
export function partitionOwnFirst<T extends { teamId: string; createdAt: Date }>(rows: T[]): T[] {
  return rows.filter(row => row.teamId === getCtx().teamId).sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime())
}
