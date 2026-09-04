/**
 * Unit matrix for the cross-team read merge ordering (services/merge.ts).
 *
 * The load-bearing invariant is the OWN-PRIMARY ∪ GRANTED ordering: a HARD
 * PARTITION, not a score/recency tiebreak. Every own-team row ranks ahead of
 * every granted-team row regardless of its raw score (vector path) or createdAt
 * (list path). `partitionOwnFirst` is that pure partition — the same one the
 * vector merge applies in step 4 — so it is the unit we exercise here without a
 * DB, a Qdrant client, or RLS GUCs.
 *
 * `partitionOwnFirst` reads the own team from getCtx() (AsyncLocalStorage), so
 * we run each assertion inside tenantStore.run(ctx, …). Importing @pm/db only
 * pulls tenantStore + lazy client live-bindings; no pool is opened at import
 * (clients are constructed by initDb/makeDbClients, never called here).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildMemoryHydrateWhere,
  partitionOwnFirst,
  reinforceMemoryAccess,
} from '../src/services/merge.ts'
import { tenantStore, type TenantCtx } from '@pm/db'

const OWN = 'team-own-uuid'
const GRANTED_A = 'team-granted-a'
const GRANTED_B = 'team-granted-b'

/** Minimal server-derived ctx; only teamId is read by partitionOwnFirst. The
 * GRANTED_* labels below are just "other team" rows under universal read — the
 * own-vs-other partition is identical. */
function ctx(ownTeam = OWN): TenantCtx {
  return {
    userId: 'u1',
    teamId: ownTeam,
    adminLevel: 'none',
    isTeamMember: true,
    isTeamAdmin: false,
    isGlobalSuperuser: false,
    mountedTeamIds: [],
    insideTenantTx: false,
  }
}

type Row = { teamId: string; createdAt: Date; tag: string }
const row = (teamId: string, isoCreatedAt: string, tag: string): Row => ({
  teamId,
  createdAt: new Date(isoCreatedAt),
  tag,
})

/** Run a partition under a tenant scope and return the resulting tags in order. */
function partitionTags(rows: Row[], ownTeam = OWN): string[] {
  return tenantStore.run(ctx(ownTeam), () => partitionOwnFirst(rows).map((r) => r.tag))
}

describe('partitionOwnFirst — own-primary ∪ granted hard partition', () => {
  it('places ALL own-team rows before ALL granted rows', () => {
    const rows = [
      row(GRANTED_A, '2026-06-01T00:00:00Z', 'g-a'),
      row(OWN, '2026-06-02T00:00:00Z', 'own-1'),
      row(GRANTED_B, '2026-06-03T00:00:00Z', 'g-b'),
      row(OWN, '2026-06-04T00:00:00Z', 'own-2'),
    ]
    const tags = partitionTags(rows)
    // own-* first (two of them), then granted-*.
    expect(tags.slice(0, 2).every((t) => t.startsWith('own-'))).toBe(true)
    expect(tags.slice(2).every((t) => t.startsWith('g-'))).toBe(true)
  })

  it('keeps a NEWER granted row behind an OLDER own row (partition beats recency)', () => {
    const rows = [
      row(OWN, '2020-01-01T00:00:00Z', 'own-ancient'),
      row(GRANTED_A, '2026-06-20T00:00:00Z', 'granted-fresh'),
    ]
    // Even though granted-fresh is far newer, own-ancient must come first.
    expect(partitionTags(rows)).toEqual(['own-ancient', 'granted-fresh'])
  })

  it('orders WITHIN each side by createdAt desc (newest first)', () => {
    const rows = [
      row(OWN, '2026-01-01T00:00:00Z', 'own-old'),
      row(OWN, '2026-06-01T00:00:00Z', 'own-new'),
      row(GRANTED_A, '2026-02-01T00:00:00Z', 'g-old'),
      row(GRANTED_B, '2026-05-01T00:00:00Z', 'g-new'),
    ]
    expect(partitionTags(rows)).toEqual(['own-new', 'own-old', 'g-new', 'g-old'])
  })

  it('multiple granted teams are all treated as one granted bucket (not own)', () => {
    const rows = [
      row(GRANTED_A, '2026-06-02T00:00:00Z', 'g-a'),
      row(GRANTED_B, '2026-06-03T00:00:00Z', 'g-b'),
      row(OWN, '2026-06-01T00:00:00Z', 'own-1'),
    ]
    expect(partitionTags(rows)).toEqual(['own-1', 'g-b', 'g-a'])
  })

  it('all-own input stays all-own (no granted bucket)', () => {
    const rows = [
      row(OWN, '2026-06-01T00:00:00Z', 'a'),
      row(OWN, '2026-06-03T00:00:00Z', 'b'),
      row(OWN, '2026-06-02T00:00:00Z', 'c'),
    ]
    expect(partitionTags(rows)).toEqual(['b', 'c', 'a'])
  })

  it('all-granted input stays all-granted, createdAt desc', () => {
    const rows = [
      row(GRANTED_A, '2026-06-01T00:00:00Z', 'a'),
      row(GRANTED_B, '2026-06-03T00:00:00Z', 'b'),
    ]
    expect(partitionTags(rows)).toEqual(['b', 'a'])
  })

  it('empty input → empty output', () => {
    expect(partitionTags([])).toEqual([])
  })

  it('own-team identity comes from getCtx (changing own team re-partitions)', () => {
    const rows = [
      row(OWN, '2026-06-01T00:00:00Z', 'x'),
      row(GRANTED_A, '2026-06-02T00:00:00Z', 'y'),
    ]
    // When GRANTED_A is the session's OWN team, y leads x.
    expect(partitionTags(rows, GRANTED_A)).toEqual(['y', 'x'])
  })
})

describe('reinforceMemoryAccess — retrieval metadata must not invalidate graph content', () => {
  it('updates only access metadata with parameterised SQL, preserving updated_at', async () => {
    const execute = vi.fn().mockResolvedValue(2)
    const at = new Date('2026-07-17T12:00:00.000Z')

    await reinforceMemoryAccess({ $executeRaw: execute } as never, ['memory-a', 'memory-b'], at)

    expect(execute).toHaveBeenCalledTimes(1)
    const query = execute.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] }
    const sql = query.strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase()
    expect(sql).toContain('update memory set last_accessed_at = ?')
    expect(sql).toContain('access_count = access_count + 1')
    expect(sql).not.toContain('updated_at')
    expect(query.values).toEqual(expect.arrayContaining([at, 'memory-a', 'memory-b']))
  })

  it('does nothing for an empty result set', async () => {
    const execute = vi.fn()
    await reinforceMemoryAccess({ $executeRaw: execute } as never, [])
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('buildMemoryHydrateWhere — relational search-scope defense', () => {
  it('reapplies the requested project and other filters during PostgreSQL hydration', () => {
    expect(
      buildMemoryHydrateWhere(['memory-a', 'memory-b'], {
        project: 'project-alpha',
        category: 'decision',
        scoreMin: 0.4,
        scoreMax: 0.9,
      }),
    ).toEqual({
      id: { in: ['memory-a', 'memory-b'] },
      project: 'project-alpha',
      category: 'decision',
      confidence: { gte: 0.4, lte: 0.9 },
    })
  })

  it('does not invent optional filters when callers omit them', () => {
    expect(buildMemoryHydrateWhere(['memory-a'], {})).toEqual({
      id: { in: ['memory-a'] },
    })
  })
})
