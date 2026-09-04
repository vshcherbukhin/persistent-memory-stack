/**
 * Unit matrix for IngestJob.graphStatus tracking (issue #9 — Track B).
 *
 * Step 6 (Graphiti add_episode) is best-effort: the job still reaches
 * status='completed' whether or not the episode write succeeds. graphStatus is
 * what makes the "in Qdrant but not the graph" partial state QUERYABLE. These
 * tests assert step 6 persists:
 *   • graphStatus='ok'      when postEpisode resolves,
 *   • graphStatus='failed'  when postEpisode throws (and the job STILL completes),
 *   • graphStatus='skipped' when the graph is not configured (empty graphitiUrl).
 *
 * Everything below step 6 (MinIO fetch, extract, chunk, persist, embed) and the
 * IngestJob status writes are mocked — this isolates the graph-status branch. We
 * run Mode B (client_bridge, embedder=null) so embedAndUpsert is never reached.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IngestJobData, IngestJobResult, Job } from '@pm/shared'
import type { WorkerDeps } from '../src/deps.ts'

// ── Mocks: the @pm/shared IO surface used by steps 1–3 ──────────────────────
vi.mock('@pm/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pm/shared')>()
  return {
    ...actual,
    getBufferCapped: vi.fn(async () => Buffer.from('hello')),
    extractText: vi.fn(async () => ({
      text: 'doc body',
      format: 'text' as const,
      pages: [],
      warnings: [],
      artifacts: [],
    })),
    chunkText: vi.fn(() => [{ ordinal: 0, content: 'doc body', tokenCount: 2 }]),
    putStream: vi.fn(async () => undefined),
  }
})

// ── Mocks: the worker step modules (persistence + the graph POST) ───────────
vi.mock('../src/steps/persist-chunks.ts', () => ({
  persistChunks: vi.fn(async () => [{ id: 'chunk-1', ordinal: 0, content: 'doc body' }]),
}))
vi.mock('../src/steps/embed.ts', () => ({
  embedAndUpsert: vi.fn(async () => 1),
}))
vi.mock('../src/steps/graphiti.ts', () => ({
  postEpisode: vi.fn(),
}))
vi.mock('../src/steps/status.ts', () => ({
  setStatus: vi.fn(async () => undefined),
  setGraphStatus: vi.fn(async () => undefined),
}))
vi.mock('@pm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pm/db')>()
  return {
    ...actual,
    runInTenant: vi.fn(async (work: (tx: unknown) => unknown) => work({
      graphLifecycleOperation: { createMany: vi.fn(async () => ({ count: 1 })) },
    })),
  }
})
// P11 document-lifecycle step — stub so the pipeline takes the 'first' branch
// (proceed, not dedup-skip) without hitting the real runInTenant/Qdrant.
vi.mock('../src/steps/document-version.ts', () => ({
  decideIngestAction: vi.fn(() => 'first'),
  hashText: vi.fn(() => 'hash'),
  readPriorDocument: vi.fn(async () => null),
  finalizeDocumentVersion: vi.fn(async () => undefined),
  stampDocumentGraphProvenance: vi.fn(async () => undefined),
  stampDocumentGraphSuccess: vi.fn(async () => undefined),
}))

// Import AFTER the mocks are registered so the pipeline binds the mocked deps.
const { makeIngestProcessor } = await import('../src/pipeline.ts')
const { postEpisode } = await import('../src/steps/graphiti.ts')
const { setStatus, setGraphStatus } = await import('../src/steps/status.ts')
const { stampDocumentGraphSuccess } = await import('../src/steps/document-version.ts')
const { runInTenant } = await import('@pm/db')

const data: IngestJobData = {
  ingestJobId: 'job-1',
  sourceId: 'src-1',
  documentId: 'doc-1',
  teamId: 'team-own',
  project: 'general',
  minioObjectKey: 'team/team-own/general/src-1/original/x.pdf',
  mimeType: 'application/pdf',
  filename: 'x.pdf',
  sessionId: null,
}

function fakeJob(): Job<IngestJobData, IngestJobResult> {
  return {
    data,
    attemptsMade: 0,
    log: vi.fn(async () => 0),
  } as unknown as Job<IngestJobData, IngestJobResult>
}

function deps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    qdrant: {} as WorkerDeps['qdrant'],
    embedder: null, // Mode B → embedAndUpsert never reached
    pin: {} as WorkerDeps['pin'],
    minio: {} as WorkerDeps['minio'],
    ingestQueue: {} as WorkerDeps['ingestQueue'],
    dlpClient: { scan: async () => ({ pii: [], secrets: [], block: false }) },
    piiEntities: [],
    piiScoreThreshold: 0.5,
    piiIngestGateEnabled: false, // these tests don't exercise the DLP gate
    embeddingMode: 'client_bridge',
    graphitiUrl: 'http://graphiti:8100',
    graphitiTimeoutMs: 1000,
    chunkMaxTokens: 100,
    chunkOverlapTokens: 10,
    maxFileBytes: 100 * 1024 * 1024,
    ...overrides,
  }
}

describe('pipeline step 6 — IngestJob.graphStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("stamps graphStatus='ok' when add_episode succeeds", async () => {
    vi.mocked(postEpisode).mockResolvedValueOnce('episode-uuid-1')
    const processor = makeIngestProcessor(deps())

    const result = await processor(fakeJob())

    // The success helper atomically persists graphStatus='ok' with the
    // document pointer and immutable episode provenance.
    expect(stampDocumentGraphSuccess).toHaveBeenCalledWith(expect.objectContaining({
      ingestJobId: 'job-1',
      documentId: 'doc-1',
      episodeId: 'episode-uuid-1',
    }))
    expect(setGraphStatus).not.toHaveBeenCalledWith('job-1', 'failed')
    // The job still completes (best-effort graph write is orthogonal to status).
    expect(setStatus).toHaveBeenCalledWith('job-1', 'completed', 0)
    expect(result.graphitiEpisodeUuid).toBe('episode-uuid-1')
    expect(stampDocumentGraphSuccess).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-1',
      teamId: 'team-own',
      project: 'general',
      episodeId: 'episode-uuid-1',
    }))
  })

  it("stamps graphStatus='failed' when add_episode throws, and the job STILL completes", async () => {
    vi.mocked(postEpisode).mockRejectedValueOnce(new Error('graphiti 502: boom'))
    const processor = makeIngestProcessor(deps())

    const result = await processor(fakeJob())

    expect(setGraphStatus).toHaveBeenCalledWith('job-1', 'failed')
    expect(setGraphStatus).not.toHaveBeenCalledWith('job-1', 'ok')
    // Best-effort: the failure does NOT fail the job — status reaches 'completed'
    // and the catch-all failed-status writer is never invoked.
    expect(setStatus).toHaveBeenCalledWith('job-1', 'completed', 0)
    expect(setStatus).not.toHaveBeenCalledWith('job-1', 'failed', 0, expect.anything())
    expect(result.graphitiEpisodeUuid).toBeUndefined()
    expect(runInTenant).toHaveBeenCalled()
  })

  it("stamps graphStatus='skipped' when the graph is not configured", async () => {
    const processor = makeIngestProcessor(deps({ graphitiUrl: '' }))

    await processor(fakeJob())

    expect(setGraphStatus).toHaveBeenCalledWith('job-1', 'skipped')
    expect(postEpisode).not.toHaveBeenCalled()
  })
})
