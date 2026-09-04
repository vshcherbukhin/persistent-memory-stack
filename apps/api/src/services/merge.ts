/**
 * persistent-memory-api — universal-read memory search merge.
 *
 * For POST /memories/search. A TWO-STORE fan-out → join → own-primary re-rank.
 * Reads are UNIVERSAL (docs/internal/users_roles.md): a team member searches ANY
 * team. Provenance is still tagged (own-team-first) so the agent sees origin.
 *
 *   1. Qdrant fan-out: searchVectors(allTeams=true) — no team filter. Hits carry
 *      teamId + score.
 *   2. Postgres hydrate UNDER RLS (runInTenant): findMany by Memory.id IN
 *      hit.rowId. RLS universal_read is the SECOND net (returns all teams for a
 *      team member; a team-less caller is rejected before reaching here).
 *   3. Own-PRIMARY ranking: a HARD PARTITION, not a score tiebreak. Every
 *      own-team hit ranks ahead of every other-team hit, regardless of raw score.
 *
 * The same own-first partition is reused (without scores, ordered createdAt
 * desc) by search-by-entities / get_memories / list_entities in the route file.
 */
import type { QdrantClient } from '@qdrant/js-client-rest'
import { searchVectors, type ActivePin } from '@pm/shared'
import { Prisma, runInTenant, getCtx, type Tx } from '@pm/db'
import { config } from '../config.ts'
import { rerankScore, type RerankWeights, type ProvenanceValue } from './rerank.ts'

/** One merged, provenance-tagged search result row. */
export interface MergedMemory {
  id: string
  content: string
  category: string
  shape: string
  entities: string[]
  project: string
  sessionId: string | null
  createdById: string | null
  score: number
  sourceTeam: string
  isOwnTeam: boolean
  createdAt: string
  recordUpdatedAt: string
  // Phase 9 provenance (surfaced so the agent sees trust + the rerank uses them).
  memoryTier: string
  sourceProvenance: ProvenanceValue
  confidence: number
}

export interface MergeArgs {
  queryVector: number[]
  pin: ActivePin
  project?: string
  category?: string
  scoreMin?: number
  scoreMax?: number
  limit: number
  /** Dashboard universal read (all teams). Default = own ∪ mounted (MCP). */
  universal?: boolean
}

export interface MergeResult {
  results: MergedMemory[]
  counts: { own: number; other: number }
}

/** The Memory columns the merge projects. */
type MemRow = {
  id: string
  teamId: string
  content: string
  category: string
  shape: string
  entities: string[]
  project: string
  sessionId: string | null
  createdById: string | null
  createdAt: Date
  recordUpdatedAt: Date
  memoryTier: string
  sourceProvenance: ProvenanceValue
  confidence: number
  lastAccessedAt: Date | null
}

const RERANK_WEIGHTS: RerankWeights = {
  alpha: config.RERANK_ALPHA,
  beta: config.RERANK_BETA,
  gamma: config.RERANK_GAMMA,
  halfLifeDays: config.RERANK_HALFLIFE_DAYS,
}

/**
 * Record an own-team retrieval without advancing Memory.updatedAt.
 *
 * Retrieval reinforcement is access metadata, not a durable memory edit. Prisma's
 * normal `memory.updateMany()` applies @updatedAt even when it only changes access
 * metadata, which would make recency describe reads instead of content changes. A
 * parameterised SQL update changes only the reinforcement fields; it remains inside
 * `runInTenant`, so RLS is still the enforcement boundary.
 */
export async function reinforceMemoryAccess(
  tx: Pick<Tx, '$executeRaw'>,
  ids: string[],
  at = new Date(),
): Promise<void> {
  if (ids.length === 0) return
  const values = Prisma.join(ids.map((id) => Prisma.sql`${id}`))
  await tx.$executeRaw(
    Prisma.sql`UPDATE memory
      SET last_accessed_at = ${at}, access_count = access_count + 1
      WHERE id IN (${values})`,
  )
}

/** Build the relational hydrate filter that independently enforces search scope. */
export function buildMemoryHydrateWhere(
  rowIds: string[],
  args: Pick<MergeArgs, 'project' | 'category' | 'scoreMin' | 'scoreMax'>,
): Prisma.MemoryWhereInput {
  return {
    id: { in: rowIds },
    ...(args.project ? { project: args.project } : {}),
    ...(args.category ? { category: args.category } : {}),
    ...(args.scoreMin !== undefined || args.scoreMax !== undefined
      ? { confidence: { gte: args.scoreMin, lte: args.scoreMax } }
      : {}),
  }
}

export async function searchMemoriesMerged(
  qdrant: QdrantClient,
  args: MergeArgs,
): Promise<MergeResult> {
  const ctx = getCtx()
  const own = ctx.teamId
  // MCP default = own ∪ mounted; dashboard universal = all teams. The Postgres
  // hydrate (RLS memory_read) is the authoritative net either way.
  const readable = [ctx.teamId, ...ctx.mountedTeamIds].filter((t): t is string => !!t)

  // 1. Qdrant fan-out.
  const hits = await searchVectors(qdrant, {
    queryVector: args.queryVector,
    pin: args.pin,
    ...(args.universal ? { allTeams: true } : { readableTeamIds: readable }),
    ...(args.project ? { project: args.project } : {}),
    sourceKind: 'memory',
    limit: args.limit,
  })
  if (hits.length === 0) return { results: [], counts: { own: 0, other: 0 } }

  // 2. Postgres hydrate UNDER RLS (defense-in-depth on top of the payload filter).
  const rowIds = hits.map((h) => h.rowId).filter((id) => id.length > 0)
  const rows = await runInTenant<MemRow[]>(
    (tx: Tx) =>
      tx.memory.findMany({
        where: buildMemoryHydrateWhere(rowIds, args),
        select: {
          id: true,
          teamId: true,
          content: true,
          category: true,
          shape: true,
          entities: true,
          project: true,
          sessionId: true,
          createdById: true,
          createdAt: true,
          recordUpdatedAt: true,
          memoryTier: true,
          sourceProvenance: true,
          confidence: true,
          lastAccessedAt: true,
        },
      }) as PromiseLike<MemRow[]>,
    args.universal ? { readAllMemory: true } : {},
  )
  const byId = new Map(rows.map((r) => [r.id, r]))

  // 3. Join + tag provenance + compute the Phase-9 rerank score. RLS-dropped rows
  //    aren't in byId → skip. `score` becomes the COMPOSITE rerank
  //    score (relevance + recency + importance, gated by provenance × confidence).
  const nowMs = Date.now()
  const merged: MergedMemory[] = []
  for (const h of hits) {
    const r = byId.get(h.rowId)
    if (!r) continue // RLS dropped it → discard the hit (second net wins)
    const composite = rerankScore(
      {
        score: h.score,
        createdAt: r.createdAt.toISOString(),
        lastAccessedAt: r.lastAccessedAt ? r.lastAccessedAt.toISOString() : null,
        confidence: r.confidence,
        sourceProvenance: r.sourceProvenance,
        shape: r.shape,
      },
      RERANK_WEIGHTS,
      nowMs,
    )
    merged.push({
      id: r.id,
      content: r.content,
      category: r.category,
      shape: r.shape,
      entities: r.entities,
      project: r.project,
      sessionId: r.sessionId,
      createdById: r.createdById,
      score: composite,
      sourceTeam: h.teamId,
      isOwnTeam: h.teamId === own,
      createdAt: r.createdAt.toISOString(),
      recordUpdatedAt: r.recordUpdatedAt.toISOString(),
      memoryTier: r.memoryTier,
      sourceProvenance: r.sourceProvenance,
      confidence: r.confidence,
    })
  }

  // 4. OWN-PRIMARY ranking — hard partition, sort each side by the rerank score desc.
  const ownHits = merged.filter((m) => m.isOwnTeam).sort((a, b) => b.score - a.score)
  const otherHits = merged.filter((m) => !m.isOwnTeam).sort((a, b) => b.score - a.score)
  const results = [...ownHits, ...otherHits]

  // 5. Reinforce-on-access (Phase 9): bump last_accessed_at + access_count for the
  //    returned rows so recency reflects actual use.
  //    Fire-and-forget + RLS-scoped: under the member ctx, team_write + owner-floor
  //    mean ONLY own-team rows are bumped — cross-team rows (mounted reads, or an
  //    admin universal search) are silently skipped. That is INTENTIONAL, not a bug:
  //    reinforcement is a per-OWNING-team usage signal, so a team's own searches keep
  //    its memories alive; an admin browsing universally (or another team mounting it)
  //    must not inflate the owner's access counts or override the owner's retention.
  //    The write is best-effort and never changes retrieval eligibility.
  //    Never blocks the search.
  if (results.length > 0 && own) {
    // own (ctx.teamId) gates this: a team-less super-admin has no team to scope a
    // write to (runInTenant would reject), and reinforcement is a team-member signal.
    const ids = results.map((m) => m.id)
    void runInTenant(
      (tx: Tx) => reinforceMemoryAccess(tx, ids),
      args.universal ? { readAllMemory: true } : {},
    ).catch(() => {})
  }

  return { results, counts: { own: ownHits.length, other: otherHits.length } }
}

/**
 * Own-first partition for non-vector lists (search-by-entities, get_memories,
 * list_entities). Orders own-team rows first, granted after, each side by
 * createdAt desc. The caller has already RLS-scoped the rows via runInTenant.
 */
export function partitionOwnFirst<T extends { teamId: string; createdAt: Date }>(
  rows: T[],
): T[] {
  const own = getCtx().teamId
  const byCreatedDesc = (a: T, b: T) => b.createdAt.getTime() - a.createdAt.getTime()
  const ownRows = rows.filter((r) => r.teamId === own).sort(byCreatedDesc)
  const grantedRows = rows.filter((r) => r.teamId !== own).sort(byCreatedDesc)
  return [...ownRows, ...grantedRows]
}
