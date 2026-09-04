/**
 * embed-backfill — the pending-embedding consumer (Phase 6, issue #3).
 *
 * A scheduled safety net: any Memory/Chunk left embeddingStatus='pending' (a Mode-B
 * write, a Mode-A edit/embed/upsert failure) is re-embedded server-side, upserted
 * to Qdrant (the SAME deterministic point id from the rowId — no orphan), and
 * flipped to 'embedded'. Mode B has no server embedder, so the job no-ops there:
 * the MCP client bridge owns embedding in Mode B.
 *
 * Cross-team by design → it runs inside a system global-admin tenant scope
 * (withSystemTenant) and uses the global-admin RLS path (runInTenant globalAdmin)
 * to read/write any team's rows. It does NOT use ownerPrisma on data tables (that
 * would defeat the RLS backstop) — widening is via the GUC the policy reads, per
 * the invariants.
 */
import { runInTenant, type Tx } from '@pm/db'
import { upsertVectors } from '@pm/shared'
import type { WorkerDeps } from '../deps.ts'
import { withSystemTenant } from '../tenant.ts'
import { withWorkerEmbeddingHealth } from '../embedding-health.ts'

/** Per-run cap PER KIND — bounded work; if the cap is hit, the next run continues. */
const BATCH = 200

type Kind = 'memory' | 'chunk'

/** The columns the backfill scan selects. */
export interface BackfillRow {
  id: string
  teamId: string
  project: string
  /** chunk rows only — carried into the Qdrant payload (P11 filter-delete identity). */
  documentId?: string | null
}

export interface BackfillItem {
  rowId: string
  sourceKind: Kind
  project: string
  vector: number[]
  documentId?: string
}

/**
 * Pure: pair rows with the vectors the embedder returned (aligned by index), drop
 * rows whose embed produced no vector (they stay 'pending' and retry next run),
 * group the rest by team (Qdrant is upserted per-team), and list the rowIds to flip.
 */
export function planBackfillUpserts(
  rows: BackfillRow[],
  vectors: (number[] | null | undefined)[],
  kind: Kind,
): { byTeam: Map<string, BackfillItem[]>; flipRowIds: string[] } {
  const byTeam = new Map<string, BackfillItem[]>()
  const flipRowIds: string[] = []
  rows.forEach((r, i) => {
    const vector = vectors[i]
    if (!vector) return // embed produced nothing → leave pending, retry next run
    const item: BackfillItem = {
      rowId: r.id,
      sourceKind: kind,
      project: r.project,
      vector,
      ...(r.documentId ? { documentId: r.documentId } : {}),
    }
    const list = byTeam.get(r.teamId)
    if (list) list.push(item)
    else byTeam.set(r.teamId, [item])
    flipRowIds.push(r.id)
  })
  return { byTeam, flipRowIds }
}

/** Scan one kind's pending rows, embed, upsert (per team), flip → count embedded. */
async function backfillKind(deps: WorkerDeps, kind: Kind): Promise<number> {
  const select = { id: true, teamId: true, project: true, content: true } as const
  const rows = (await runInTenant<(BackfillRow & { content: string })[]>(
    (tx: Tx) =>
      (kind === 'memory'
        ? tx.memory.findMany({ where: { embeddingStatus: 'pending' }, select, take: BATCH, orderBy: { createdAt: 'asc' } })
        : tx.chunk.findMany({ where: { embeddingStatus: 'pending' }, select: { ...select, documentId: true }, take: BATCH, orderBy: { createdAt: 'asc' } })) as PromiseLike<
        (BackfillRow & { content: string })[]
      >,
    { globalAdmin: true, readOnly: true },
  )) as (BackfillRow & { content: string })[]
  if (rows.length === 0) return 0

  const embedder = deps.embedder!
  const { vectors } = await withWorkerEmbeddingHealth(
    embedder,
    () => embedder.embed(rows.map((r) => r.content), 'document'),
  )

  const { byTeam, flipRowIds } = planBackfillUpserts(rows, vectors, kind)
  if (flipRowIds.length === 0) return 0

  // Upsert per team (Qdrant payload carries team_id — the tenant boundary). The
  // point id is deterministic from rowId, so this recreates the SAME point.
  const pointIds = new Map<string, string>()
  for (const [teamId, items] of byTeam) {
    const idByRow = await upsertVectors(deps.qdrant, { teamId, pin: deps.pin, items })
    for (const [rid, pid] of idByRow) pointIds.set(rid, pid)
  }

  // Flip the embedded rows (global-admin write path — cross-team, owner-floor bypassed).
  // GUARDED by `embeddingStatus: 'pending'` (updateMany, since Prisma `update` only
  // takes a unique where): only mark a row embedded if it is STILL pending. Between
  // the scan and here, a concurrent API edit may have re-embedded the row inline (→
  // embedded) — we must NOT clobber that with our (now-stale) vector/status. count 0
  // → the row moved on; skip it. (ponytail: a row re-marked pending mid-run by a
  // Mode-A edit failure can still take our stale vector — vanishingly rare for a
  // safety-net over Mode-A failure rows, and self-corrected when next edited; the
  // upgrade path is an optimistic updatedAt/version guard if it ever matters.)
  let flipped = 0
  await runInTenant(async (tx: Tx) => {
    for (const id of flipRowIds) {
      const data = {
        qdrantPointId: pointIds.get(id),
        embeddingModelId: deps.pin.modelId,
        embeddingDim: deps.pin.dim,
        embeddingStatus: 'embedded' as const,
      }
      const r =
        kind === 'memory'
          ? await tx.memory.updateMany({ where: { id, embeddingStatus: 'pending' }, data })
          : await tx.chunk.updateMany({ where: { id, embeddingStatus: 'pending' }, data })
      flipped += r.count
    }
  }, { globalAdmin: true })

  return flipped
}

/** The scheduled-job entry point. Returns a short summary for ScheduledJob.logTail. */
export async function embedBackfill(deps: WorkerDeps): Promise<string> {
  if (deps.embeddingMode !== 'server' || !deps.embedder) {
    return 'skipped (Mode B — the client bridge owns embedding; pending rows are embedded by the MCP)'
  }
  return withSystemTenant(async () => {
    const memories = await backfillKind(deps, 'memory')
    const chunks = await backfillKind(deps, 'chunk')
    if (memories === 0 && chunks === 0) return 'nothing pending'
    const capNote = memories === BATCH || chunks === BATCH ? ' (batch cap hit — more pending, next run continues)' : ''
    return `embedded ${memories} memory + ${chunks} chunk pending row(s)${capNote}`
  })
}
