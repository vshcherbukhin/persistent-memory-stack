/**
 * Embedding-model switch DRIVER (Phase 10, #5) — the novel correctness claim is
 * the TWO-PASS, no-dual-write sequencing: add+backfill+FLIP (noDrop) → backfill
 * AGAIN (catches flip-window writes) → drop. We mock the @pm/shared switch steps +
 * the in-process pin so we assert ordering + terminal status without a live stack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  runSwitch: vi.fn(),
  step3Reembed: vi.fn(),
  step5DropOld: vi.fn(),
  makeEmbedderForPin: vi.fn(),
  planSwitch: vi.fn((fm: string, fd: number, tm: string, td: number) => ({
    from: { modelId: fm, dim: fd, vectorName: `${fm}__${fd}` },
    to: { modelId: tm, dim: td, vectorName: `${tm}__${td}` },
  })),
  applyActivePin: vi.fn(),
  ssUpdate: vi.fn(),
}))

vi.mock('@pm/shared', () => ({
  planSwitch: h.planSwitch,
  runSwitch: h.runSwitch,
  step3Reembed: h.step3Reembed,
  step5DropOld: h.step5DropOld,
  makeEmbedderForPin: h.makeEmbedderForPin,
}))
vi.mock('../src/services/embedding.ts', () => ({ qdrant: {}, applyActivePin: h.applyActivePin }))
vi.mock('@pm/db', () => ({
  ownerPrisma: { systemSettings: { update: h.ssUpdate } },
  runInTenant: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  tenantStore: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  Prisma: {},
}))

import { runModelSwitch, isSwitchRunning, resumableFailedSwitch } from '../src/services/model-switch.ts'

const FROM = { model: 'qwen3-embedding:4b', dim: 2560 }
const TO = { model: 'qwen3-embedding:4b', dim: 1024 }

beforeEach(() => {
  vi.clearAllMocks()
  h.makeEmbedderForPin.mockReturnValue({ embed: vi.fn(async (t: string[]) => t.map(() => [0.1])) })
  // runSwitch (pass 1 + flip): invoke savePin to simulate the flip, like the real tool.
  h.runSwitch.mockImplementation(async (_c: unknown, plan: { to: { modelId: string; dim: number } }, hooks: { savePin: (p: unknown) => Promise<void>; noDrop?: boolean }) => {
    await hooks.savePin(plan.to)
    return { added: true, migrated: 2, flipped: true, dropped: false }
  })
  h.step3Reembed.mockResolvedValue({ migrated: 2 })
  h.step5DropOld.mockResolvedValue({ dropped: true })
})

describe('runModelSwitch — two-pass sequencing', () => {
  it('runs add+backfill+flip (noDrop) → backfill again → drop, in that order', async () => {
    await runModelSwitch(FROM, TO, new Date().toISOString())

    // runSwitch invoked with noDrop:true (flip happens here; drop deferred to us).
    expect(h.runSwitch).toHaveBeenCalledTimes(1)
    expect(h.runSwitch.mock.calls[0]![2].noDrop).toBe(true)
    // Pass 2 reembed + drop each fire exactly once.
    expect(h.step3Reembed).toHaveBeenCalledTimes(1)
    expect(h.step5DropOld).toHaveBeenCalledTimes(1)
    // Order: runSwitch (pass 1 + flip) → step3Reembed (pass 2) → step5DropOld.
    const o1 = h.runSwitch.mock.invocationCallOrder[0]!
    const o2 = h.step3Reembed.mock.invocationCallOrder[0]!
    const o3 = h.step5DropOld.mock.invocationCallOrder[0]!
    expect(o1).toBeLessThan(o2)
    expect(o2).toBeLessThan(o3)
  })

  it('flips the live in-process pin at the flip step (savePin → applyActivePin)', async () => {
    await runModelSwitch(FROM, TO, new Date().toISOString())
    expect(h.applyActivePin).toHaveBeenCalledWith(TO.model, TO.dim)
  })

  it('writes a terminal "done" status with the re-embedded count', async () => {
    await runModelSwitch(FROM, TO, new Date().toISOString())
    const done = h.ssUpdate.mock.calls
      .map((c) => (c[0] as { data: { embeddingSwitch?: { state?: string; migrated?: number } } }).data.embeddingSwitch)
      .find((s) => s?.state === 'done')
    expect(done).toBeTruthy()
    expect(done!.migrated).toBe(2)
  })

  it('on a step failure writes a terminal "failed" status (never leaves "running")', async () => {
    h.step5DropOld.mockRejectedValueOnce(new Error('qdrant exploded'))
    await runModelSwitch(FROM, TO, new Date().toISOString())
    const failed = h.ssUpdate.mock.calls
      .map((c) => (c[0] as { data: { embeddingSwitch?: { state?: string; error?: string } } }).data.embeddingSwitch)
      .find((s) => s?.state === 'failed')
    expect(failed).toBeTruthy()
    expect(failed!.error).toMatch(/qdrant exploded/)
  })
})

describe('isSwitchRunning — concurrent-switch guard', () => {
  it('true for a recent running status', () => {
    expect(isSwitchRunning({ state: 'running', startedAt: new Date().toISOString() })).toBe(true)
  })
  it('false for a STALE running status (crashed switch must not wedge the pin)', () => {
    const stale = new Date(Date.now() - 31 * 60_000).toISOString()
    expect(isSwitchRunning({ state: 'running', startedAt: stale })).toBe(false)
  })
  it('false for done / failed / null', () => {
    expect(isSwitchRunning({ state: 'done', startedAt: new Date().toISOString() })).toBe(false)
    expect(isSwitchRunning({ state: 'failed', startedAt: new Date().toISOString() })).toBe(false)
    expect(isSwitchRunning(null)).toBe(false)
  })
})

describe('resumableFailedSwitch — post-flip recovery', () => {
  it('returns the original pin only when a failed switch already targets the active pin', () => {
    expect(resumableFailedSwitch({ state: 'failed', from: FROM, to: TO }, TO)).toEqual(FROM)
  })

  it('never resumes an unrelated or malformed failure', () => {
    expect(resumableFailedSwitch({ state: 'failed', from: FROM, to: TO }, FROM)).toBeNull()
    expect(resumableFailedSwitch({ state: 'failed' }, TO)).toBeNull()
  })
})
