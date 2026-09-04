/**
 * Scenario I — document lifecycle (Phase 11, #6).
 *
 *   • DELETE cleans all four stores: ingest → search finds a chunk → DELETE → the
 *     chunk is gone from search AND GET /documents/:id → 404.
 *   • DEDUP: re-uploading the SAME (project, filename) with UNCHANGED content reuses
 *     the same documentId and does NOT bump the version (no re-chunk/re-embed).
 *   • VERSION-IN-PLACE: re-uploading the SAME filename with CHANGED content keeps the
 *     documentId, bumps versionNumber, and the NEW content is searchable while the OLD
 *     marker is gone (stale chunks/points superseded).
 *
 * Routes: POST /ingest, GET /ingest/:jobId, POST /documents/search,
 * GET /documents/:id (now returns versionNumber/filename), DELETE /documents/:id.
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
  status: 'queued' | 'extracting' | 'embedding' | 'completed' | 'failed'
  error: string | null
}
interface DocSearch {
  results: Array<{ chunkId: string; documentId: string; content: string }>
  counts: { own: number; other: number }
}
interface DocGet {
  id: string
  filename: string | null
  versionNumber: number
}

const admin = bootstrapToken()
const PROJECT = `it-doclife-${uniqueSuffix()}`
let team: Team
let member: ProvisionedMember

/** Upload a doc and poll the job to a terminal state; returns the accept body + final status. */
async function ingest(
  filename: string,
  content: string,
  title?: string,
): Promise<{ accepted: IngestAccepted; final: IngestStatus }> {
  const up = await apiMultipart<IngestAccepted>('/ingest', {
    token: member.token,
    filename,
    content,
    contentType: 'text/plain',
    fields: { project: PROJECT, ...(title ? { title } : {}) },
  })
  expect(up.status, JSON.stringify(up.json)).toBe(201)
  const final = await poll<IngestStatus>(
    async () => (await api<IngestStatus>('GET', `/ingest/${up.json.jobId}`, { token: member.token })).json,
    (s) => s.status === 'completed' || s.status === 'failed',
    { timeoutMs: 60_000, intervalMs: 1_500 },
  )
  expect(final.status, `ingest ended ${final.status} (${final.error})`).toBe('completed')
  return { accepted: up.json, final }
}

const search = (query: string): Promise<{ status: number; json: DocSearch }> =>
  api<DocSearch>('POST', '/documents/search', { token: member.token, body: { query, project: PROJECT, limit: 30 } })

beforeAll(async () => {
  const p = await provisionTeamWithMember(admin, 'doclife')
  team = p.team
  member = p.member
})
afterAll(async () => {
  await teardownTeamWithMember(admin, team, member)
})

describe('Phase-11 DELETE cleans all four stores', () => {
  it('deletes a document → chunk gone from search + GET 404', async () => {
    const TAG = `delmark${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`
    const { accepted } = await ingest(
      `delete-me-${TAG}.txt`,
      `Lifecycle delete test ${TAG}. The widget pipeline indexes this chunk so search can find ${TAG}.`,
    )
    // Present pre-delete.
    const before = await search(TAG)
    expect(before.json.results.some((c) => c.content.includes(TAG)), 'found pre-delete').toBe(true)

    const del = await api<{ deleted: true; chunkPoints: number }>('DELETE', `/documents/${accepted.documentId}`, {
      token: member.token,
    })
    expect(del.status, JSON.stringify(del.json)).toBe(200)
    expect(del.json.deleted).toBe(true)

    // Gone from Postgres (GET 404) and from the vector index (search miss).
    const get = await api('GET', `/documents/${accepted.documentId}`, { token: member.token })
    expect(get.status).toBe(404)
    const after = await search(TAG)
    expect(after.json.results.some((c) => c.content.includes(TAG)), 'gone post-delete').toBe(false)
  })
})

describe('Phase-11 dedup + version-in-place', () => {
  const FILENAME = `versioned-${uniqueSuffix()}.txt`
  const V1TAG = `vone${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`
  const V2TAG = `vtwo${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`
  const v1Body = `Lifecycle version test ${V1TAG}. The first revision describes the widget auth flow ${V1TAG}.`
  let documentId = ''

  it('first ingest → version 1', async () => {
    const { accepted } = await ingest(FILENAME, v1Body, 'Versioned doc')
    documentId = accepted.documentId
    const get = await api<DocGet>('GET', `/documents/${documentId}`, { token: member.token })
    expect(get.status).toBe(200)
    expect(get.json.versionNumber).toBe(1)
    expect(get.json.filename).toBe(FILENAME)
  })

  it('re-upload IDENTICAL content → deduped (same id, version stays 1)', async () => {
    const { accepted } = await ingest(FILENAME, v1Body)
    expect(accepted.documentId, 'same logical document').toBe(documentId)
    const get = await api<DocGet>('GET', `/documents/${documentId}`, { token: member.token })
    expect(get.json.versionNumber, 'unchanged content must NOT bump the version').toBe(1)
    // v1 content still searchable.
    expect((await search(V1TAG)).json.results.some((c) => c.content.includes(V1TAG))).toBe(true)
  })

  it('re-upload CHANGED content → version 2, new content searchable, old marker gone', async () => {
    const v2Body = `Lifecycle version test ${V2TAG}. The second revision rewrites the widget flow entirely ${V2TAG}.`
    const { accepted } = await ingest(FILENAME, v2Body)
    expect(accepted.documentId, 'still the same logical document').toBe(documentId)
    const get = await api<DocGet>('GET', `/documents/${documentId}`, { token: member.token })
    expect(get.json.versionNumber, 'changed content bumps the version').toBe(2)

    // New content is searchable; the old marker's chunks were superseded.
    expect((await search(V2TAG)).json.results.some((c) => c.content.includes(V2TAG)), 'v2 searchable').toBe(true)
    expect((await search(V1TAG)).json.results.some((c) => c.content.includes(V1TAG)), 'v1 superseded').toBe(false)
  })
})
