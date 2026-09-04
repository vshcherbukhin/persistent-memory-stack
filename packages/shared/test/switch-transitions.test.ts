/**
 * Switch-tool STATE TRANSITIONS — runSwitch sequencing + the per-step gates.
 *
 * The 5-step zero-downtime named-vector migration:
 *   1 ADD (idempotent) → 2 dual-write ON → 3 backfill → 4 FLIP (savePin) →
 *   5 DROP old + dual-write OFF.
 * noFlip stops after 3 (old pin still active); noDrop stops after 4 (reversible
 * window, old vector retained). Steps are resume-safe (idempotent) on a restart.
 *
 * A fake QdrantClient models the named-vector set + a points store so we assert
 * the observable transitions (which vectors exist, dual-write toggles, savePin)
 * without a live Qdrant.
 */
import { describe, it, expect, vi } from 'vitest'
import { runSwitch } from '../src/switch/run.ts'
import type { RunSwitchHooks } from '../src/switch/run.ts'
import { planSwitch, step1AddVector, step3Reembed, step5DropOld } from '../src/switch/migration.ts'
import type { QdrantClient } from '@qdrant/js-client-rest'
import type { ActivePin } from '../src/types/index.ts'

const PLAN = planSwitch('qwen3-embedding:0.6b', 1024, 'nomic-embed-text', 768)
// from = qwen3-embedding-0.6b__1024 ; to = nomic-embed-text__768

interface FakeState {
  vectors: Set<string>
  /** Each entry: pointId -> { [vectorName]: vector } written via updateVectors. */
  written: Map<string | number, Record<string, number[]>>
}

function fakeClient(opts: {
  initialVectors?: string[]
  points?: Array<{ id: string | number; row_id: string }>
  missingPointIds?: Array<string | number>
}): { client: QdrantClient; state: FakeState; scrollPages: number } {
  const state: FakeState = {
    vectors: new Set(opts.initialVectors ?? [PLAN.from.vectorName]),
    written: new Map(),
  }
  let scrollPages = 0
  const pts = opts.points ?? []
  const client = {
    async getCollection() {
      const vectors: Record<string, unknown> = {}
      for (const v of state.vectors) vectors[v] = { size: 1, distance: 'Cosine' }
      return { config: { params: { vectors } } }
    },
    async createVectorName(_c: string, name: string) {
      state.vectors.add(name)
    },
    async deleteVectorName(_c: string, name: string) {
      state.vectors.delete(name)
    },
    async scroll(_c: string, _o: any) {
      // Single page then exhausted (next_page_offset null).
      if (scrollPages > 0) return { points: [], next_page_offset: null }
      scrollPages++
      return {
        points: pts.map((p) => ({ id: p.id, payload: { row_id: p.row_id } })),
        next_page_offset: null,
      }
    },
    async updateVectors(_c: string, body: any) {
      if (body.points.some((p: { id: string | number }) => opts.missingPointIds?.includes(p.id))) {
        throw new Error('Not Found')
      }
      for (const p of body.points) {
        const cur = state.written.get(p.id) ?? {}
        Object.assign(cur, p.vector)
        state.written.set(p.id, cur)
      }
    },
  } as unknown as QdrantClient
  return {
    client,
    state,
    get scrollPages() {
      return scrollPages
    },
  }
}

function hooks(over: Partial<RunSwitchHooks> = {}): {
  hooks: RunSwitchHooks
  saved: ActivePin[]
  dualWrite: Array<ActivePin | null>
  log: string[]
} {
  const saved: ActivePin[] = []
  const dualWrite: Array<ActivePin | null> = []
  const log: string[] = []
  const h: RunSwitchHooks = {
    embed: async (texts) => texts.map(() => new Array(PLAN.to.dim).fill(0.2)),
    fetchText: async (rowIds) => new Map(rowIds.map((r) => [r, `text for ${r}`])),
    savePin: async (pin) => {
      saved.push(pin)
    },
    setDualWrite: async (t) => {
      dualWrite.push(t)
    },
    log: (m) => log.push(m),
    ...over,
  }
  return { hooks: h, saved, dualWrite, log }
}

describe('runSwitch — full happy-path transition (add → dual-write → backfill → flip → drop)', () => {
  it('walks all 5 steps in order and ends with old dropped + target active', async () => {
    const f = fakeClient({ points: [{ id: 'p1', row_id: 'r1' }, { id: 'p2', row_id: 'r2' }] })
    const h = hooks()
    const result = await runSwitch(f.client, PLAN, h.hooks)

    expect(result).toEqual({ added: true, migrated: 2, flipped: true, dropped: true })
    // Target vector added, old vector dropped.
    expect(f.state.vectors.has(PLAN.to.vectorName)).toBe(true)
    expect(f.state.vectors.has(PLAN.from.vectorName)).toBe(false)
    // Flip persisted the target pin exactly once.
    expect(h.saved).toEqual([PLAN.to])
    // Dual-write toggled ON (target) at step 2, then OFF (null) at step 5 — in order.
    expect(h.dualWrite).toEqual([PLAN.to, null])
    // Backfill wrote ONLY the target named vector onto each point.
    expect([...f.state.written.keys()].sort()).toEqual(['p1', 'p2'])
    for (const v of f.state.written.values()) {
      expect(Object.keys(v)).toEqual([PLAN.to.vectorName])
    }
  })
})

describe('runSwitch — noFlip gate (stop after backfill)', () => {
  it('does not flip or drop; old vector + old pin stay active, dual-write left ON', async () => {
    const f = fakeClient({ points: [{ id: 'p1', row_id: 'r1' }] })
    const h = hooks({ noFlip: true })
    const result = await runSwitch(f.client, PLAN, h.hooks)

    expect(result).toEqual({ added: true, migrated: 1, flipped: false, dropped: false })
    expect(h.saved).toEqual([]) // no flip
    expect(h.dualWrite).toEqual([PLAN.to]) // turned ON, never turned OFF
    expect(f.state.vectors.has(PLAN.from.vectorName)).toBe(true) // old retained
    expect(f.state.vectors.has(PLAN.to.vectorName)).toBe(true) // target added
  })
})

describe('runSwitch — noDrop gate (flip but keep old vector: reversible window)', () => {
  it('flips the pin yet retains the old vector and never disables dual-write', async () => {
    const f = fakeClient({ points: [{ id: 'p1', row_id: 'r1' }] })
    const h = hooks({ noDrop: true })
    const result = await runSwitch(f.client, PLAN, h.hooks)

    expect(result).toEqual({ added: true, migrated: 1, flipped: true, dropped: false })
    expect(h.saved).toEqual([PLAN.to]) // flipped
    expect(h.dualWrite).toEqual([PLAN.to]) // ON only; no OFF (drop step skipped)
    expect(f.state.vectors.has(PLAN.from.vectorName)).toBe(true) // old retained → reversible
  })
})

describe('switch steps — idempotency / resume-safety', () => {
  it('step1AddVector is a no-op when the target vector already exists (added:false)', async () => {
    const f = fakeClient({ initialVectors: [PLAN.from.vectorName, PLAN.to.vectorName] })
    const spy = vi.spyOn(f.client, 'createVectorName')
    const r = await step1AddVector(f.client, PLAN)
    expect(r.added).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('step5DropOld is a no-op when the old vector is already gone (dropped:false)', async () => {
    const f = fakeClient({ initialVectors: [PLAN.to.vectorName] }) // old already absent
    const spy = vi.spyOn(f.client, 'deleteVectorName')
    const r = await step5DropOld(f.client, PLAN)
    expect(r.dropped).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a full run over an ALREADY-migrated collection is harmless (added:false, dropped:false)', async () => {
    const f = fakeClient({ initialVectors: [PLAN.to.vectorName], points: [] })
    const h = hooks()
    const result = await runSwitch(f.client, PLAN, h.hooks)
    expect(result.added).toBe(false)
    expect(result.dropped).toBe(false)
    expect(result.flipped).toBe(true)
  })
})

describe('step3Reembed — backfill mechanics', () => {
  it('re-embeds from fetched source text and reports the migrated count', async () => {
    const f = fakeClient({ points: [{ id: 'p1', row_id: 'r1' }, { id: 'p2', row_id: 'r2' }] })
    const fetchText = vi.fn(async (rowIds: string[]) => new Map(rowIds.map((r) => [r, `src ${r}`])))
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Array(PLAN.to.dim).fill(0.3)))
    const r = await step3Reembed(f.client, PLAN, { embed, fetchText })

    expect(r.migrated).toBe(2)
    expect(fetchText).toHaveBeenCalledWith(['r1', 'r2'])
    expect(embed).toHaveBeenCalledWith(['src r1', 'src r2'])
    // Each point now carries ONLY the target named vector (old vector untouched).
    for (const v of f.state.written.values()) {
      expect(Object.keys(v)).toEqual([PLAN.to.vectorName])
      expect((v[PLAN.to.vectorName] ?? []).length).toBe(PLAN.to.dim)
    }
  })

  it('skips stale/deleted points without failing the whole migration', async () => {
    const f = fakeClient({ points: [{ id: 'p1', row_id: 'r1' }, { id: 'p2', row_id: 'deleted' }, { id: 'p3', row_id: 'r3' }], missingPointIds: ['p3'] })
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Array(PLAN.to.dim).fill(0.3)))

    const r = await step3Reembed(f.client, PLAN, {
      embed,
      fetchText: async () => new Map([['r1', 'live source'], ['r3', 'deleted after scroll']]),
    })

    expect(embed).toHaveBeenCalledWith(['live source', 'deleted after scroll'])
    expect(r.migrated).toBe(1)
    expect([...f.state.written.keys()]).toEqual(['p1'])
  })
})
