/**
 * Scenario D — document ingest pipeline end to end.
 *
 *   1. POST /ingest — multipart upload of a small text file (part name "file").
 *      → 201 {jobId,sourceId,documentId,status:'queued'}.
 *   2. GET /ingest/:jobId — poll until status === 'completed' (or 'failed').
 *      Assert graphStatus is one of the known values (pending|ok|failed|skipped);
 *      step 6 (Graphiti) is best-effort, so 'failed'/'skipped' is acceptable on a
 *      dev stack — only the presence + enum membership is asserted.
 *   3. POST /documents/search — a chunk of the ingested text is found.
 *
 * Route shapes:
 *   POST /ingest          — api/src/routes/ingest.ts (multipart; fields project/title/sessionId optional)
 *   GET  /ingest/:jobId   — api/src/routes/ingest.ts → {id,status,graphStatus,project,sourceId,attempts,error,createdAt,updatedAt}
 *   POST /documents/search — api/src/routes/documents.ts (body {query,project?,limit?}) → {results[ChunkHit],counts}
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api, apiMultipart, poll } from './client.ts'
import {
  bootstrapToken,
  provisionTeamWithMember,
  teardownTeamWithMember,
  uniqueSuffix,
  type Team,
  type ProvisionedMember,
} from './provision.ts'

interface IngestAccepted {
  jobId: string
  sourceId: string
  documentId: string
  status: 'queued'
}
interface IngestStatus {
  id: string
  status: 'queued' | 'extracting' | 'embedding' | 'completed' | 'failed'
  graphStatus: 'pending' | 'ok' | 'failed' | 'skipped'
  project: string
  sourceId: string | null
  attempts: number
  error: string | null
}
interface DocSearch {
  results: Array<{ chunkId: string; documentId: string; ordinal: number; content: string; project: string }>
  counts: { own: number; other: number }
}

const admin = bootstrapToken()
const PROJECT = `it-ingest-${uniqueSuffix()}`
const TAG = `ingesttag${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`

// A short but multi-sentence body so the extractor produces at least one chunk
// containing the unique TAG (which we then search for).
const FILE_BODY = [
  `Persistent Memory integration test document ${TAG}.`,
  'The widget pipeline ingests documents, extracts text, chunks it, and embeds each chunk into Qdrant.',
  `This sentence intentionally repeats the marker ${TAG} so a semantic search can rank this chunk highly.`,
  'The temporal knowledge graph is built best-effort after the chunks are embedded.',
].join('\n')

let team: Team
let member: ProvisionedMember

beforeAll(async () => {
  const p = await provisionTeamWithMember(admin, 'ingest')
  team = p.team
  member = p.member
})

afterAll(async () => {
  // NOTE: ingest creates Source/Document/Chunk rows; the team-delete presence
  // probe will refuse a non-empty team (409), so the team row lingers. That is
  // expected — purge memories + delete the user; the team cleanup is best-effort.
  await teardownTeamWithMember(admin, team, member)
})

describe('document ingest pipeline (data plane)', () => {
  let jobId = ''

  it('accepts a multipart upload (→ queued)', async () => {
    const res = await apiMultipart<IngestAccepted>('/ingest', {
      token: member.token,
      filename: `it-${TAG}.txt`,
      content: FILE_BODY,
      contentType: 'text/plain',
      fields: { project: PROJECT, title: `IT ingest ${TAG}` },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.jobId).toBeTruthy()
    expect(res.json.status).toBe('queued')
    jobId = res.json.jobId
  })

  it('completes the job (poll) and reports a graphStatus', async () => {
    const final = await poll<IngestStatus>(
      async () => {
        const r = await api<IngestStatus>('GET', `/ingest/${jobId}`, { token: member.token })
        expect(r.status, JSON.stringify(r.json)).toBe(200)
        return r.json
      },
      (s) => s.status === 'completed' || s.status === 'failed',
      { timeoutMs: 50_000, intervalMs: 1_500 },
    )
    expect(final.status, `ingest job ended in ${final.status} (error: ${final.error})`).toBe(
      'completed',
    )
    // graphStatus is tracked independently (best-effort step 6) — assert presence
    // + enum membership, not a specific outcome.
    expect(['pending', 'ok', 'failed', 'skipped']).toContain(final.graphStatus)
  })

  it('finds an ingested chunk via document search', async () => {
    const res = await api<DocSearch>('POST', '/documents/search', {
      token: member.token,
      body: { query: `widget pipeline ${TAG}`, project: PROJECT, limit: 20 },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.results.length, 'document search should return at least one chunk').toBeGreaterThan(0)
    const hit = res.json.results.find((c) => c.content.includes(TAG))
    expect(hit, 'a chunk containing the unique marker should be found').toBeTruthy()
    expect(hit!.project).toBe(PROJECT)
  })

  // Phase 8: the DLP gate also covers DOCUMENTS — a sensitive upload is blocked in
  // the worker (post-extraction) → job failed/pii_detected, no chunks indexed.
  it('BLOCKS a document containing a secret (worker DLP gate) → failed/pii_detected', async () => {
    const SECRET_TAG = `secret${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`
    const SECRET_BODY = [
      `Persistent Memory ingest DLP test ${SECRET_TAG}.`,
      'The deploy script accidentally embedded a credential below.',
      'github_token = ghp_wWPw5k4aXcaT4fNP0UcnZwJjcg9kZM0123ab',
    ].join('\n')
    const up = await apiMultipart<IngestAccepted>('/ingest', {
      token: member.token,
      filename: `it-${SECRET_TAG}.txt`,
      content: SECRET_BODY,
      contentType: 'text/plain',
      fields: { project: PROJECT, title: `IT secret ${SECRET_TAG}` },
    })
    expect(up.status, JSON.stringify(up.json)).toBe(201)

    const final = await poll<IngestStatus>(
      async () => (await api<IngestStatus>('GET', `/ingest/${up.json.jobId}`, { token: member.token })).json,
      (s) => s.status === 'completed' || s.status === 'failed',
      { timeoutMs: 50_000, intervalMs: 1_500 },
    )
    expect(final.status, 'a secret-bearing document must be blocked').toBe('failed')
    expect(final.error ?? '').toContain('pii_detected')

    // The blocked document's content must NOT be searchable (no chunks indexed).
    const search = await api<DocSearch>('POST', '/documents/search', {
      token: member.token,
      body: { query: SECRET_TAG, project: PROJECT, limit: 20 },
    })
    expect(search.json.results.find((c) => c.content.includes(SECRET_TAG))).toBeFalsy()
  })
})
