/**
 * Unit: planRequeue — the pure decision for the ingest-reconciler (Phase 7, #7).
 * Given `queued` IngestJobs (joined with their Source + first Document) and the set
 * of jobIds that STILL have a live Bull job, it: skips the live ones, skips ones whose
 * canonical rows are too incomplete to rebuild a payload (left queued), and rebuilds
 * a faithful IngestJobData payload for the rest.
 *
 * The DB scan + Bull getJob/enqueue are effectful (covered by the integration wiring);
 * this isolates the skip/rebuild logic.
 */
import { describe, it, expect } from 'vitest'
import { planRequeue, type StuckJob } from '../src/steps/ingest-reconciler.ts'

const job = (id: string, over: Partial<StuckJob> = {}): StuckJob => ({
  id,
  teamId: 'tA',
  project: 'general',
  sessionId: null,
  sourceId: `src-${id}`,
  source: {
    title: `${id}.pdf`,
    minioObjectKey: `team/tA/general/src-${id}/${id}.pdf`,
    documents: [{ id: `doc-${id}`, mimeType: 'application/pdf' }],
  },
  ...over,
})

describe('planRequeue', () => {
  it('rebuilds a faithful payload for a lost job (no live Bull job)', () => {
    const { payloads, skippedLive, skippedUnreconstructable } = planRequeue([job('j1')], new Set())
    expect(skippedLive).toBe(0)
    expect(skippedUnreconstructable).toBe(0)
    expect(payloads).toEqual([
      {
        ingestJobId: 'j1',
        sourceId: 'src-j1',
        documentId: 'doc-j1',
        teamId: 'tA',
        project: 'general',
        minioObjectKey: 'team/tA/general/src-j1/j1.pdf',
        mimeType: 'application/pdf',
        filename: 'j1.pdf',
        sessionId: null,
      },
    ])
  })

  it('skips a job that still has a live Bull job', () => {
    const { payloads, skippedLive } = planRequeue([job('j1'), job('j2')], new Set(['j1']))
    expect(skippedLive).toBe(1)
    expect(payloads.map((p) => p.ingestJobId)).toEqual(['j2'])
  })

  it('skips (does not requeue) a job whose canonical rows are incomplete', () => {
    const noSource = job('j1', { source: null, sourceId: null })
    const noKey = job('j2', { source: { title: 't', minioObjectKey: null, documents: [{ id: 'd', mimeType: 'x' }] } })
    const noDoc = job('j3', { source: { title: 't', minioObjectKey: 'k', documents: [] } })
    const { payloads, skippedUnreconstructable } = planRequeue([noSource, noKey, noDoc], new Set())
    expect(payloads).toEqual([])
    expect(skippedUnreconstructable).toBe(3)
  })

  it('defaults a missing mimeType to application/octet-stream', () => {
    const noMime = job('j1', {
      source: { title: 'a.bin', minioObjectKey: 'k', documents: [{ id: 'd', mimeType: null }] },
    })
    const { payloads } = planRequeue([noMime], new Set())
    expect(payloads[0].mimeType).toBe('application/octet-stream')
  })
})
