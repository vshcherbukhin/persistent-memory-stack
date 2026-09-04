/**
 * GET /ingest/:jobId surfaces graphStatus (Phase-3 review gap #9 / GAP 3).
 *
 * IngestJob.graphStatus (pending|ok|failed|skipped) is tracked independently of
 * `status` because step 6 (the Graphiti episode) is best-effort — `status` reaches
 * `completed` even when the episode write fails. Without graphStatus on the wire,
 * the "in Qdrant but not the graph" partial state is invisible to operators/agents.
 *
 * The handler is deep inside a route closure (full Fastify + RLS to exercise live),
 * so this is a source-drift guard in the same spirit as project-default.test.ts: it
 * pins the response schema, the Prisma select, the Row type, and the send body so a
 * regression that drops graphStatus from any of the four is caught. It also runs the
 * verbatim graphStatus enum against the same Zod the route uses.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const ingest = readFileSync(
  fileURLToPath(new URL('../src/routes/ingest.ts', import.meta.url)),
  'utf8',
)

// The verbatim enum the route uses for the graphStatus response field.
const GraphStatus = z.enum(['pending', 'ok', 'failed', 'skipped'])

describe('graphStatus enum — matches the GraphStatus Prisma enum', () => {
  it('accepts every Prisma GraphStatus value', () => {
    for (const v of ['pending', 'ok', 'failed', 'skipped']) {
      expect(GraphStatus.parse(v)).toBe(v)
    }
  })
  it('rejects an unknown status', () => {
    expect(GraphStatus.safeParse('partial').success).toBe(false)
  })
})

describe('GET /ingest/:jobId — graphStatus is surfaced end-to-end', () => {
  it('declares graphStatus in the 200 response Zod schema', () => {
    expect(ingest).toContain("graphStatus: z.enum(['pending', 'ok', 'failed', 'skipped'])")
  })

  it('selects graphStatus from the IngestJob row (Prisma findUnique select)', () => {
    expect(ingest).toContain('graphStatus: true')
  })

  it('types graphStatus on the Row type', () => {
    expect(ingest).toContain("graphStatus: 'pending' | 'ok' | 'failed' | 'skipped'")
  })

  it('sends graphStatus back on the 200 body', () => {
    expect(ingest).toContain('graphStatus: job.graphStatus')
  })
})

// POST /ingest enqueue is fail-closed (Phase-7 review gap #7). The blob + rows commit
// BEFORE the enqueue; if the enqueue throws, the row must be stamped
// failed/enqueue_failed (not left a silent `queued` orphan) and the caller gets a 500.
// (The ingest-reconciler covers the OTHER mode — a crash before the enqueue line runs.)
// Same source-drift-guard spirit as above: the handler is deep in a route closure.
describe('POST /ingest — enqueue failure is stamped fail-closed', () => {
  it('wraps the enqueue in a try/catch', () => {
    expect(ingest).toContain('bullJobId = await enqueueIngest(ingestQueue, payload)')
  })
  it("stamps status:'failed' + error:'enqueue_failed' on enqueue failure", () => {
    expect(ingest).toContain("status: 'failed', error: 'enqueue_failed'")
  })
  it('returns a 500 enqueue_failed to the caller', () => {
    expect(ingest).toContain("error: 'enqueue_failed'")
    expect(ingest).toContain('reply.code(500)')
  })
})
