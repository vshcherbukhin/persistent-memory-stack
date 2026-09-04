/**
 * Scenario E — the managed scheduled-worker subsystem (Phase 5) is live.
 *
 * Against the running stack (api + worker + Redis), exercises the full lifecycle of
 * the 'usage-sweep' managed job through /dashboard/workers:
 *   1. GET /dashboard/workers lists usage-sweep (enabled, with a cron) + worker liveness.
 *   2. A PLAIN MEMBER can READ /dashboard/workers (any-auth, like /dashboard/services)…
 *   3. …but a plain member CANNOT mutate (run-now → 403; requireSuperuser).
 *   4. run-now (superuser) → the worker runs it → status flips to 'success' with a
 *      fresh lastRunAt (the BullMQ scheduler → worker → ScheduledJob row path works).
 *   5. pause → enabled:false, no next-run; resume → enabled:true, next-run returns.
 *   6. schedule CRUD: PUT a new cron persists; an invalid cron is rejected (400).
 *
 * Route shapes (api/src/routes/dashboard/workers.ts):
 *   GET  /dashboard/workers                 → {workers:[{name,cron,enabled,status,lastRunAt,nextRunAt,...}], liveness:{alive,...}}
 *   POST /dashboard/workers/:name/:action   → action pause|resume|run-now; 200 {ok} | 403 | 404
 *   PUT  /dashboard/workers/:name           → body {cron?,enabled?}; 200 {ok} | 400 invalid_cron | 404
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api, poll } from './client.ts'
import { bootstrapToken, provisionTeamWithMember, teardownTeamWithMember, type Team, type ProvisionedMember } from './provision.ts'

const JOB = 'usage-sweep'
const DEFAULT_CRON = '0 3 * * *'

interface WorkerRow {
  name: string
  cron: string
  enabled: boolean
  status: string
  lastRunAt: string | null
  nextRunAt: string | null
  errorCount: number
}
interface WorkersBody {
  workers: WorkerRow[]
  liveness: { alive: boolean; lastBeatAgoMs: number | null }
}

const admin = bootstrapToken()
let memberTeam: Team
let member: ProvisionedMember

const getWorkers = (token: string) => api<WorkersBody>('GET', '/dashboard/workers', { token })
const findJob = (b: WorkersBody) => b.workers.find((w) => w.name === JOB)

beforeAll(async () => {
  const m = await provisionTeamWithMember(admin, 'workersMember')
  memberTeam = m.team
  member = m.member
})

afterAll(async () => {
  // Restore the job to its shipped schedule + enabled (this is a shared singleton).
  await api('PUT', `/dashboard/workers/${JOB}`, { token: admin, body: { cron: DEFAULT_CRON, enabled: true } }).catch(() => {})
  await teardownTeamWithMember(admin, memberTeam, member)
})

describe('Phase-5 managed scheduled workers', () => {
  it('lists usage-sweep with a schedule + reports worker liveness', async () => {
    const res = await getWorkers(admin)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const job = findJob(res.json)
    expect(job, 'usage-sweep must be registered').toBeTruthy()
    expect(job!.cron.length).toBeGreaterThan(0)
    // The worker is up in the live stack → heartbeat present.
    expect(res.json.liveness.alive, 'worker should be alive').toBe(true)
  })

  it('a plain member can READ the workers list (any-auth)', async () => {
    const res = await getWorkers(member.token)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(findJob(res.json)).toBeTruthy()
  })

  it('a plain member CANNOT run a job (superuser-only)', async () => {
    const res = await api('POST', `/dashboard/workers/${JOB}/run-now`, { token: member.token })
    expect(res.status).toBe(403)
  })

  it('run-now triggers the worker and flips status to success with a fresh lastRunAt', async () => {
    const before = findJob((await getWorkers(admin)).json)
    const beforeRun = before?.lastRunAt ?? null

    const run = await api<{ ok: boolean }>('POST', `/dashboard/workers/${JOB}/run-now`, { token: admin })
    expect(run.status, JSON.stringify(run.json)).toBe(200)

    // Poll until the worker processed it: lastRunAt advanced AND status is success.
    const done = await poll(
      async () => findJob((await getWorkers(admin)).json),
      (j) => !!j && j.status === 'success' && j.lastRunAt !== beforeRun,
      { timeoutMs: 30_000, intervalMs: 1_000 },
    )
    expect(done?.status, 'usage-sweep should complete successfully').toBe('success')
    expect(done?.lastRunAt, 'lastRunAt should advance').not.toBe(beforeRun)
    expect(done?.errorCount).toBe(0)
  })

  it('pause removes the next-run; resume restores it', async () => {
    const paused = await api<{ ok: boolean }>('POST', `/dashboard/workers/${JOB}/pause`, { token: admin })
    expect(paused.status, JSON.stringify(paused.json)).toBe(200)
    let job = findJob((await getWorkers(admin)).json)
    expect(job?.enabled).toBe(false)
    expect(job?.nextRunAt, 'a paused job has no next run').toBeNull()

    const resumed = await api<{ ok: boolean }>('POST', `/dashboard/workers/${JOB}/resume`, { token: admin })
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(200)
    // The scheduler is re-registered → a next-run reappears (poll; Redis is async).
    job = await poll(
      async () => findJob((await getWorkers(admin)).json),
      (j) => !!j && j.enabled && j.nextRunAt !== null,
      { timeoutMs: 10_000, intervalMs: 500 },
    )
    expect(job?.enabled).toBe(true)
    expect(job?.nextRunAt, 'a resumed job has a next run').not.toBeNull()
  })

  it('schedule CRUD: a new cron persists; an invalid cron is rejected', async () => {
    const NEW_CRON = '0 4 * * *'
    const ok = await api<{ ok: boolean }>('PUT', `/dashboard/workers/${JOB}`, { token: admin, body: { cron: NEW_CRON } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(findJob((await getWorkers(admin)).json)?.cron).toBe(NEW_CRON)

    const bad = await api<{ error: string }>('PUT', `/dashboard/workers/${JOB}`, { token: admin, body: { cron: 'not a cron' } })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe('invalid_cron')
    // The bad edit must NOT have changed the persisted cron.
    expect(findJob((await getWorkers(admin)).json)?.cron).toBe(NEW_CRON)
  })
})

// ── Phase 6: pending-embedding consumer ──────────────────────────────────────
const BACKFILL = 'embed-backfill'
interface PendingBody {
  memories: number
  chunks: number
  embeddingMode: string
}

describe('Phase-6 embed-backfill consumer', () => {
  it('is registered as a managed scheduled job', async () => {
    const res = await getWorkers(admin)
    const job = res.json.workers.find((w) => w.name === BACKFILL)
    expect(job, 'embed-backfill must be registered').toBeTruthy()
    expect(job!.cron.length).toBeGreaterThan(0)
  })

  it('exposes a pending-embeddings count to the dashboard', async () => {
    const res = await api<PendingBody>('GET', '/dashboard/memories/pending', { token: admin })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(typeof res.json.memories).toBe('number')
    expect(typeof res.json.chunks).toBe('number')
    expect(res.json.embeddingMode.length).toBeGreaterThan(0)
  })

  it('force-run drives the worker to a successful run (Mode-A safety net)', async () => {
    const before = (await getWorkers(admin)).json.workers.find((w) => w.name === BACKFILL)
    const beforeRun = before?.lastRunAt ?? null

    const run = await api<{ ok: boolean }>('POST', `/dashboard/workers/${BACKFILL}/run-now`, { token: admin })
    expect(run.status, JSON.stringify(run.json)).toBe(200)

    const done = await poll(
      async () => (await getWorkers(admin)).json.workers.find((w) => w.name === BACKFILL),
      (j) => !!j && j.status === 'success' && j.lastRunAt !== beforeRun,
      { timeoutMs: 30_000, intervalMs: 1_000 },
    )
    expect(done?.status, 'embed-backfill should complete successfully').toBe('success')
    expect(done?.errorCount).toBe(0)
  })

  it('a plain member cannot force-run the backfill (superuser-only)', async () => {
    const res = await api('POST', `/dashboard/workers/${BACKFILL}/run-now`, { token: member.token })
    expect(res.status).toBe(403)
  })
})

// ── Phase 7: ingest reconciler ───────────────────────────────────────────────
// The lost-job → re-queue loop needs DB access to plant a stuck `queued` row (no
// HTTP path induces one), so the end-to-end recovery is proven by the planRequeue
// unit + a manual psql smoke. Here we verify the same wiring P5/P6 verify: the job
// is registered, a superuser can force-run it green, and members are gated out.
const RECONCILER = 'ingest-reconciler'

describe('Phase-7 ingest reconciler', () => {
  it('is registered as a managed scheduled job', async () => {
    const job = (await getWorkers(admin)).json.workers.find((w) => w.name === RECONCILER)
    expect(job, 'ingest-reconciler must be registered').toBeTruthy()
    expect(job!.cron.length).toBeGreaterThan(0)
  })

  it('force-run drives the worker to a successful run', async () => {
    const before = (await getWorkers(admin)).json.workers.find((w) => w.name === RECONCILER)
    const beforeRun = before?.lastRunAt ?? null

    const run = await api<{ ok: boolean }>('POST', `/dashboard/workers/${RECONCILER}/run-now`, { token: admin })
    expect(run.status, JSON.stringify(run.json)).toBe(200)

    const done = await poll(
      async () => (await getWorkers(admin)).json.workers.find((w) => w.name === RECONCILER),
      (j) => !!j && j.status === 'success' && j.lastRunAt !== beforeRun,
      { timeoutMs: 30_000, intervalMs: 1_000 },
    )
    expect(done?.status, 'ingest-reconciler should complete successfully').toBe('success')
    expect(done?.errorCount).toBe(0)
  })

  it('a plain member cannot force-run the reconciler (superuser-only)', async () => {
    const res = await api('POST', `/dashboard/workers/${RECONCILER}/run-now`, { token: member.token })
    expect(res.status).toBe(403)
  })
})

// ── Phase 8: pii-scan DLP safety net ─────────────────────────────────────────
const PIISCAN = 'pii-scan'

describe('Phase-8 pii-scan job', () => {
  it('is registered as a managed scheduled job', async () => {
    const job = (await getWorkers(admin)).json.workers.find((w) => w.name === PIISCAN)
    expect(job, 'pii-scan must be registered').toBeTruthy()
    expect(job!.cron.length).toBeGreaterThan(0)
  })

  it('force-run drives the worker to a successful run', async () => {
    const before = (await getWorkers(admin)).json.workers.find((w) => w.name === PIISCAN)
    const beforeRun = before?.lastRunAt ?? null

    const run = await api<{ ok: boolean }>('POST', `/dashboard/workers/${PIISCAN}/run-now`, { token: admin })
    expect(run.status, JSON.stringify(run.json)).toBe(200)

    const done = await poll(
      async () => (await getWorkers(admin)).json.workers.find((w) => w.name === PIISCAN),
      (j) => !!j && j.status === 'success' && j.lastRunAt !== beforeRun,
      { timeoutMs: 60_000, intervalMs: 1_500 },
    )
    expect(done?.status, 'pii-scan should complete successfully').toBe('success')
    expect(done?.errorCount).toBe(0)
  })

  it('a plain member cannot force-run pii-scan (superuser-only)', async () => {
    const res = await api('POST', `/dashboard/workers/${PIISCAN}/run-now`, { token: member.token })
    expect(res.status).toBe(403)
  })
})

// Graph history is retained deliberately; score is not an archive/delete trigger.
// The old worker is reconciled away during update and must not be reachable again.
describe('retired memory-archive worker', () => {
  it('is not registered or force-runnable', async () => {
    const workers = (await getWorkers(admin)).json.workers
    expect(workers.some((worker) => worker.name === 'memory-archive')).toBe(false)

    const run = await api('POST', '/dashboard/workers/memory-archive/run-now', { token: admin })
    expect(run.status).toBe(404)
  })
})
