/**
 * Scenario J — worker parallelism (Phase 12, #8). Upload several documents AT ONCE
 * and assert every job drains to 'completed' and each doc's unique marker is
 * searchable. Validates that concurrent ingests (WORKER_CONCURRENCY) are processed
 * safely — independent, tenant-scoped jobs with no cross-job state corruption.
 *
 * (The bounded read / OOM ceiling from #8 — getBufferCapped + mem_limit — is covered
 * by the shared getBufferCapped unit test + the container mem_limit; it isn't probed
 * here because forcing an over-cap blob/OOM through the HTTP harness isn't feasible.)
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

interface IngestAccepted { jobId: string; documentId: string; status: 'queued' }
interface IngestStatus { status: 'queued' | 'extracting' | 'embedding' | 'completed' | 'failed'; error: string | null }
interface DocSearch { results: Array<{ content: string }> }

const admin = bootstrapToken()
const PROJECT = `it-par-${uniqueSuffix()}`
let team: Team
let member: ProvisionedMember

beforeAll(async () => {
  const p = await provisionTeamWithMember(admin, 'par')
  team = p.team
  member = p.member
})
afterAll(async () => {
  await teardownTeamWithMember(admin, team, member)
})

describe('Phase-12 concurrent multi-file ingest', () => {
  it('drains 4 simultaneous uploads → all completed + each searchable', async () => {
    const tags = Array.from({ length: 4 }, (_, i) => `partag${i}${uniqueSuffix().replace(/[^a-z0-9]/g, '')}`)

    // Fire all uploads AT ONCE (no awaiting between them).
    const accepted = await Promise.all(
      tags.map((tag) =>
        apiMultipart<IngestAccepted>('/ingest', {
          token: member.token,
          filename: `par-${tag}.txt`,
          content: `Parallelism test ${tag}. The widget pipeline ingests this concurrently with siblings ${tag}.`,
          contentType: 'text/plain',
          fields: { project: PROJECT, title: `IT par ${tag}` },
        }),
      ),
    )
    for (const a of accepted) expect(a.status, JSON.stringify(a.json)).toBe(201)

    // Every job reaches completed.
    const finals = await Promise.all(
      accepted.map((a) =>
        poll<IngestStatus>(
          async () => (await api<IngestStatus>('GET', `/ingest/${a.json.jobId}`, { token: member.token })).json,
          (s) => s.status === 'completed' || s.status === 'failed',
          { timeoutMs: 90_000, intervalMs: 1_500 },
        ),
      ),
    )
    finals.forEach((f, i) => expect(f.status, `job ${i} ended ${f.status} (${f.error})`).toBe('completed'))

    // Each document's unique marker is searchable (no cross-job content corruption).
    for (const tag of tags) {
      const res = await api<DocSearch>('POST', '/documents/search', {
        token: member.token,
        body: { query: `widget pipeline ${tag}`, project: PROJECT, limit: 30 },
      })
      expect(res.json.results.some((c) => c.content.includes(tag)), `${tag} searchable`).toBe(true)
    }
  })
})
