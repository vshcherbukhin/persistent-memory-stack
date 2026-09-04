/**
 * Vector search.
 *
 *   • Reads are UNIVERSAL in the new access model (docs/internal/users_roles.md):
 *     a team member may search ANY team. Pass `allTeams: true` to omit the team
 *     filter entirely; the authoritative net is the Postgres RLS hydrate at the
 *     caller (which under universal read returns all teams). This is safe ONLY
 *     because reads are genuinely universal.
 *   • For a (future) team-scoped search, pass `readableTeamIds` and leave
 *     `allTeams` unset: Filter.should = OR over team_id values (tenant-OR).
 *     `should`-only ⇒ matches points satisfying ≥1 clause; NEVER put team_id in
 *     `must` (would AND-collapse to a single team). Empty list → fail-closed.
 *   • `must` (project / source_kind) ANDs WITHIN the result set.
 *   • `using` selects the ACTIVE named vector; the query vector dim MUST equal
 *     the active dim (a wrong-model query returns garbage scores silently).
 *   • Hits are tagged with teamId so the caller can sort own-first.
 */
import type { QdrantClient } from '@qdrant/js-client-rest'
import type { ActivePin, VectorSourceKind } from '../types/index.ts'
import { COLLECTION } from './types.ts'
import type { SearchHit } from './types.ts'

export interface SearchArgs {
  queryVector: number[]
  pin: ActivePin
  /** Universal read — omit the team filter entirely (RLS hydrate is the net). */
  allTeams?: boolean
  /** Team-scoped fallback (own first). Ignored when allTeams is true. */
  readableTeamIds?: string[]
  project?: string
  sourceKind?: VectorSourceKind
  limit?: number
}

export async function searchVectors(
  client: QdrantClient,
  args: SearchArgs,
): Promise<SearchHit[]> {
  if (!args.allTeams && (!args.readableTeamIds || args.readableTeamIds.length === 0)) {
    return [] // fail-closed: a scoped search with no scope returns nothing
  }
  if (args.queryVector.length !== args.pin.dim) {
    throw new Error(
      `qdrant search: query vector dim ${args.queryVector.length} != active dim ${args.pin.dim}. ` +
        `Embed the query with the pinned model (${args.pin.modelId}).`,
    )
  }

  const should = args.allTeams
    ? []
    : args.readableTeamIds!.map((tid) => ({ key: 'team_id', match: { value: tid } }))
  const must: Array<Record<string, unknown>> = []
  if (args.project) must.push({ key: 'project', match: { value: args.project } })
  if (args.sourceKind) must.push({ key: 'source_kind', match: { value: args.sourceKind } })

  const res = await client.query(COLLECTION, {
    query: args.queryVector,
    using: args.pin.vectorName, // ACTIVE named vector
    filter: { ...(should.length ? { should } : {}), ...(must.length ? { must } : {}) },
    limit: args.limit ?? 20,
    with_payload: true,
  })

  return res.points.map((p) => {
    const pl = (p.payload ?? {}) as Record<string, unknown>
    return {
      pointId: String(p.id),
      rowId: String(pl.row_id ?? ''),
      teamId: String(pl.team_id ?? ''),
      project: String(pl.project ?? ''),
      sourceKind: pl.source_kind as VectorSourceKind,
      score: p.score ?? 0,
    }
  })
}
