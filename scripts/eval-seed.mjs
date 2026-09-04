#!/usr/bin/env node
/**
 * persistent-memory — MCP-eval seed fixture (Phase 14, #12).
 *
 * Loads the FROZEN fixture the apps/mcp/evals.xml questions resolve against, via the REAL
 * api over HTTP (no DB access) — idempotent: reuses the `qa-automation`/`qa-manual`
 * teams by name and purges qa-automation's memories before re-seeding so counts are
 * stable. Prints the qa-automation read_write wire token at the end — that token goes
 * in the MCP config the eval drives (PM_USER_TOKEN).
 *
 * Run:  PM_BOOTSTRAP_TOKEN=<seed-token> PM_API_BASE=http://localhost:8090 \
 *         node scripts/eval-seed.mjs
 *
 * The 2 graph questions (contradiction/timeline) depend on Graphiti extraction
 * quality (a separately-documented local-model gap), so the episodes are seeded but
 * those answers are verified/marked at eval time, not asserted here.
 */
const BASE = process.env.PM_API_BASE ?? 'http://localhost:8090'
const BOOTSTRAP_TOKEN = process.env.PM_BOOTSTRAP_TOKEN
if (!BOOTSTRAP_TOKEN) {
  console.error('PM_BOOTSTRAP_TOKEN is required (the show-once bootstrap super-admin token).')
  process.exit(1)
}

async function api(method, path, { token = BOOTSTRAP_TOKEN, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json }
}

async function findOrCreateTeam(name) {
  const list = await api('GET', '/dashboard/teams')
  const teams = list.json?.teams ?? list.json ?? []
  const found = teams.find((t) => t.name === name)
  if (found) return found.id
  const created = await api('POST', '/dashboard/teams', { body: { name } })
  if (created.status !== 201) throw new Error(`createTeam(${name}): ${created.status} ${JSON.stringify(created.json)}`)
  return created.json.id
}

async function createMemberWithToken(teamId, label) {
  const u = await api('POST', '/dashboard/users', { body: { teamId, email: `${label}-${Date.now()}@eval.test`, displayName: `eval ${label}` } })
  if (u.status !== 201) throw new Error(`createUser: ${u.status} ${JSON.stringify(u.json)}`)
  const t = await api('POST', `/dashboard/users/${u.json.id}/token`, { body: {} })
  if (t.status !== 201) throw new Error(`issueToken: ${t.status} ${JSON.stringify(t.json)}`)
  return { userId: u.json.id, token: t.json.wireToken }
}

/** A gotcha-shaped memory (the shape that reliably passes the Shape A–E write gate). */
function gotcha(entity, body, fix, prevention) {
  return {
    content: `[${entity}] ${body} Root cause: ${fix.cause}. Fix: ${fix.fix}. Prevention: ${prevention}.`,
    project: 'qa-platform',
    metadata: { category: 'gotcha', entities: [entity], source: 'gotcha-discovered', severity: 'high' },
  }
}

async function main() {
  console.log(`[eval-seed] api=${BASE}`)
  const qaAutomation = await findOrCreateTeam('qa-automation')
  const qaManual = await findOrCreateTeam('qa-manual')
  console.log(`[eval-seed] teams: qa-automation=${qaAutomation.slice(0, 8)} qa-manual=${qaManual.slice(0, 8)}`)

  // Mount: qa-automation (grantee) reads qa-manual (grantor) → 2 readable teams.
  const grant = await api('POST', '/dashboard/grants', { body: { grantorTeamId: qaManual, granteeTeamId: qaAutomation } })
  if (grant.status !== 201) console.warn(`[eval-seed] grant: ${grant.status} (ok if already exists)`)

  // Members + read_write tokens (adminLevel 'none' → read_write on own team's memories).
  const auto = await createMemberWithToken(qaAutomation, 'automation')
  const manual = await createMemberWithToken(qaManual, 'manual')

  // Clean slate for stable counts (purge qa-automation memories; super-admin bulk delete).
  await api('DELETE', '/dashboard/memories', { body: { teamId: qaAutomation, confirm: true } })

  // ── Memories (qa-automation) — crafted so the eval questions resolve ──────────
  const memories = [
    // Q4: vector store loses tenant visibility when payloads are rewritten → category 'gotcha'.
    gotcha('component_qdrant',
      'Rewriting a stored vector point payload can drop the tenant key, so a team stops seeing its own vectors in search.',
      { cause: 'an upsert that replaces the whole payload instead of merging it', fix: 'always re-stamp team_id on payload writes' },
      'never rewrite a point payload without the tenant boundary field'),
    // Q5: DB enforces team isolation as defense-in-depth beneath the app choke-point → entity component_persistent_memory_postgres.
    gotcha('component_persistent_memory_postgres',
      'The database enforces team isolation as a defense-in-depth net beneath the application authorization choke-point.',
      { cause: 'trusting the app layer alone for tenant scoping', fix: 'row-level security policies keyed to a per-request team GUC' },
      'every data-plane query runs inside the tenant transaction'),
    // Q6: two memories touching the read_write-permission entity → count 2.
    gotcha('permission_read_write',
      'A token that grants write access to its own team can create and edit memories there.',
      { cause: 'role confusion between read and write tokens', fix: 'derive the data-plane role from the server-side token' },
      'never trust a client-asserted role'),
    gotcha('permission_read_write',
      'The read_write permission is bounded to the current team — it never crosses team boundaries on the data plane.',
      { cause: 'assuming write access is global', fix: 'stamp team_id server-side on every write' },
      'cross-team writes go only through the dashboard global-admin path'),
  ]
  for (const m of memories) {
    const r = await api('POST', '/memories', { token: auto.token, body: m })
    if (r.status !== 201) throw new Error(`memory create: ${r.status} ${JSON.stringify(r.json)}`)
  }
  console.log(`[eval-seed] ${memories.length} memories seeded in qa-automation`)

  // One memory in qa-manual (so the cross-team read is real → Q6 + the 2-team count).
  await api('POST', '/memories', { token: manual.token, body: gotcha('component_manual_runbook',
    'The manual QA runbook is the source of truth for release sign-off steps.',
    { cause: 'undocumented sign-off', fix: 'link the runbook in the release ticket' }, 'keep the runbook current') })

  // ── Document (Q9): a markdown doc about quarterly test coverage → mimetype ─────
  // P11 dedups by (team, project, filename), so re-runs reuse/version it in place.
  const md = '# Quarterly Test Coverage Report\n\nAutomated test coverage for the QA platform this quarter: line coverage 84%, branch 71%. The biggest gaps are the ingestion pipeline and the deployment-mode auth paths.'
  const form = new FormData()
  form.append('file', new Blob([md], { type: 'text/markdown' }), 'quarterly-test-coverage.md')
  form.append('project', 'qa-platform')
  form.append('title', 'Quarterly Test Coverage')
  const up = await fetch(`${BASE}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${auto.token}` }, body: form })
  const upJson = await up.json().catch(() => ({}))
  if (up.status === 201) {
    // Poll to completed so the doc is searchable when the eval runs.
    for (let i = 0; i < 40; i++) {
      const s = await api('GET', `/ingest/${upJson.jobId}`, { token: auto.token })
      if (s.json?.status === 'completed') { console.log('[eval-seed] doc ingested + completed'); break }
      if (s.json?.status === 'failed') { console.warn(`[eval-seed] doc ingest FAILED: ${s.json?.error}`); break }
      await new Promise((r) => setTimeout(r, 1500))
    }
  } else {
    console.warn(`[eval-seed] doc ingest: ${up.status} ${JSON.stringify(upJson)}`)
  }

  console.log('\n[eval-seed] DONE. qa-automation read_write token (PM_USER_TOKEN for the MCP):')
  console.log(auto.token)
}

main().catch((e) => { console.error('[eval-seed] FAILED:', e.message); process.exit(1) })
