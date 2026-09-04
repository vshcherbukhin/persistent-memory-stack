/**
 * RLS floor verification — runs the security-critical Row-Level Security matrix
 * as the `pm_app` role with explicit GUCs (the access model: docs/internal/
 * users_roles.md). This is the DB-level backstop proof: even with a buggy API,
 * Postgres returns/permits only the right rows.
 *
 * PRECONDITIONS (a throwaway DB is fine):
 *   1. Postgres up; migrations applied (`prisma migrate deploy` as the owner).
 *   2. layers/core/schema/rls.sql applied (creates pm_app + the policies).
 *   3. DATABASE_URL (pm_app) + DATABASE_MIGRATE_URL (owner) in the env, or in
 *      the repo's .env.persistent-memory file.
 *
 * Run: node layers/core/tools/rls-check.mjs   (exits non-zero on any failed assertion)
 *
 * It seeds fixtures as the OWNER (superuser, bypasses RLS), then drives every
 * scenario as pm_app inside rolled-back transactions so fixtures persist.
 */
import pg from 'pg'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { Client } = pg
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const envPath = resolve(repoRoot, '.env.persistent-memory')

function readDotenvValue(file, key) {
  if (!existsSync(file)) return undefined
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const currentKey = line.slice(0, eq).trim()
    if (currentKey !== key) continue
    const value = line.slice(eq + 1).trim()
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      return value.slice(1, -1)
    }
    return value
  }
  return undefined
}

function hostReachableUrl(value, fromEnvFile) {
  if (!fromEnvFile || !value) return value
  try {
    const url = new URL(value)
    if (url.hostname === 'persistent-memory-postgres' && url.port === '5432') {
      url.hostname = 'localhost'
      url.port = '5433'
      return url.toString()
    }
  } catch {
    return value
  }
  return value
}

function configValue(key) {
  if (process.env[key]) return process.env[key]
  return hostReachableUrl(readDotenvValue(envPath, key), true)
}

const OWNER_URL = configValue('DATABASE_MIGRATE_URL')
const APP_URL = configValue('DATABASE_URL')
if (!OWNER_URL || !APP_URL) {
  console.error('Set DATABASE_MIGRATE_URL (owner) and DATABASE_URL (pm_app), or create .env.persistent-memory.')
  process.exit(2)
}

let failures = 0
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// Deterministic fixture ids.
const TEAM_A = '2f4c4e99-c327-4a85-bd7b-4f451d5df312'
const TEAM_B = 'b7606ccd-726c-4702-8678-49997a8f4f0a'
const USER_U = 'c2ab5e60-3df1-475d-bf9a-2dc98e4d8b26'
const USER_V = 'fa7648ba-e0df-4f59-b254-26afb57c10db'
const MEM_U_A = '94af58db-c608-463d-83b8-8ba0a41d1163' // team A, author U
const MEM_V_A = '48511e1d-cd99-4284-9f9d-52524fd120a5' // team A, author V
const MEM_B = 'e6c06e80-0437-4694-9e97-193d9c80582b' // team B, author null
const MEM_FIXTURES = [MEM_U_A, MEM_V_A, MEM_B]
const ALERT_A = 'df36153c-0b68-4fc2-9268-15208285e8b3' // security_alert, team A
const ALERT_B = '07e1b6c7-aa6c-40f2-bb37-1a421cbb8946' // security_alert, team B

async function seed(owner) {
  // Idempotent-ish: wipe our fixtures, then insert. Owner bypasses RLS.
  await owner.query(`DELETE FROM security_alert WHERE id = ANY($1)`, [[ALERT_A, ALERT_B]])
  await owner.query(`DELETE FROM memory WHERE id = ANY($1)`, [[MEM_U_A, MEM_V_A, MEM_B]])
  await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[USER_U, USER_V]])
  await owner.query(`DELETE FROM team WHERE id = ANY($1)`, [[TEAM_A, TEAM_B]])
  await owner.query(`INSERT INTO team (id, name, created_at, updated_at) VALUES ($1,'rls-A',now(),now()),($2,'rls-B',now(),now())`, [TEAM_A, TEAM_B])
  await owner.query(`INSERT INTO app_user (id, team_id, admin_level, created_at, updated_at) VALUES ($1,$3,'none',now(),now()),($2,$3,'none',now(),now())`, [USER_U, USER_V, TEAM_A])
  const mem = (id, team, author) =>
    owner.query(
      `INSERT INTO memory (id, team_id, created_by_id, project, content, category, shape, entities, embedding_status, created_at, updated_at)
       VALUES ($1,$2,$3,'general','content','gotcha','gotcha_fix','{}','pending',now(),now())`,
      [id, team, author],
    )
  await mem(MEM_U_A, TEAM_A, USER_U)
  await mem(MEM_V_A, TEAM_A, USER_V)
  await mem(MEM_B, TEAM_B, null)
  const alert = (id, team) =>
    owner.query(
      `INSERT INTO security_alert (id, team_id, source_kind, detector, finding_type, severity, created_at, updated_at)
       VALUES ($1,$2,'memory','presidio','US_SSN','high',now(),now())`,
      [id, team],
    )
  await alert(ALERT_A, TEAM_A)
  await alert(ALERT_B, TEAM_B)
}

/** Run fn inside a tx with the given GUCs, then ROLLBACK (keep fixtures). */
async function withGucs(app, gucs, fn) {
  await app.query('BEGIN')
  try {
    for (const [k, v] of Object.entries(gucs)) {
      await app.query('SELECT set_config($1, $2, true)', [k, v])
    }
    return await fn()
  } finally {
    await app.query('ROLLBACK')
  }
}

// MCP member: own team only for MEMORY (no mounts, not dashboard); can_read_all
// is for the SHARED tables (docs/graph), which stay universal.
const memberGucs = { 'app.user_id': USER_U, 'app.team_id': TEAM_A, 'app.can_read_all': 'true', 'app.mounted_team_ids': '', 'app.read_all_memory': 'false', 'app.is_global_admin': 'false', 'app.bypass_owner_floor': 'false' }
// Same member, but their team has MOUNTED team B (cross-team memory read).
const memberMountedGucs = { ...memberGucs, 'app.mounted_team_ids': TEAM_B }
// Same member on the DASHBOARD (universal memory read).
const memberDashboardGucs = { ...memberGucs, 'app.read_all_memory': 'true' }
const adminGucs = { ...memberGucs, 'app.bypass_owner_floor': 'true' }
const globalGucs = { 'app.user_id': USER_U, 'app.team_id': TEAM_B, 'app.can_read_all': 'true', 'app.mounted_team_ids': '', 'app.read_all_memory': 'false', 'app.is_global_admin': 'true', 'app.bypass_owner_floor': 'true' }

async function count(app, sql, params) {
  const r = await app.query(sql, params)
  return r.rowCount ?? 0
}

async function main() {
  const owner = new Client({ connectionString: OWNER_URL })
  const app = new Client({ connectionString: APP_URL })
  await owner.connect()
  await app.connect()
  try {
    await seed(owner)

    // ── Member (U, team A): MEMORY read = own team only (no mounts). ─────────────
    await withGucs(app, memberGucs, async () => {
      ok((await count(app, 'SELECT 1 FROM memory')) === 2, 'member (no mount): MEMORY read sees OWN team only (2), not team B')
      ok((await count(app, `UPDATE memory SET content='x' WHERE id=$1`, [MEM_U_A])) === 1, 'member: UPDATE own row ok')
      ok((await count(app, `UPDATE memory SET content='x' WHERE id=$1`, [MEM_V_A])) === 0, 'member: UPDATE teammate row blocked (owner_floor)')
      ok((await count(app, `UPDATE memory SET content='x' WHERE id=$1`, [MEM_B])) === 0, 'member: UPDATE other-team row blocked')
      ok((await count(app, `DELETE FROM memory WHERE id=$1`, [MEM_V_A])) === 0, 'member: DELETE teammate row blocked')
      ok((await count(app, `DELETE FROM memory WHERE id=$1`, [MEM_U_A])) === 1, 'member: DELETE own row ok')
    })
    await withGucs(app, memberGucs, async () => {
      let inserted = false
      try { await app.query(`INSERT INTO memory (id, team_id, created_by_id, project, content, category, shape, entities, embedding_status, created_at, updated_at) VALUES (gen_random_uuid(),$1,$2,'general','c','gotcha','gotcha_fix','{}','pending',now(),now())`, [TEAM_A, USER_U]); inserted = true } catch { inserted = false }
      ok(inserted, 'member: INSERT into own team ok')
    })
    await withGucs(app, memberGucs, async () => {
      let blocked = false
      try { await app.query(`INSERT INTO memory (id, team_id, project, content, category, shape, entities, embedding_status, created_at, updated_at) VALUES (gen_random_uuid(),$1,'general','c','gotcha','gotcha_fix','{}','pending',now(),now())`, [TEAM_B]) } catch { blocked = true }
      ok(blocked, 'member: INSERT into other team blocked (write_floor WITH CHECK)')
    })

    // ── Member whose team MOUNTED team B → memory read = own ∪ mounted. ─────────
    await withGucs(app, memberMountedGucs, async () => {
      ok((await count(app, 'SELECT 1 FROM memory')) === 3, 'member (mounted B): MEMORY read sees own ∪ mounted (3)')
      ok((await count(app, `UPDATE memory SET content='x' WHERE id=$1`, [MEM_B])) === 0, 'member (mounted B): mounted team is READ-only (UPDATE blocked)')
    })

    // ── Member on the DASHBOARD → universal memory read (all teams). ─────────────
    await withGucs(app, memberDashboardGucs, async () => {
      ok((await count(app, 'SELECT 1 FROM memory WHERE id = ANY($1)', [MEM_FIXTURES])) === 3, 'member (dashboard): universal memory read sees all 3 fixture rows')
    })

    // ── Team-admin (bypass owner floor), team A. ────────────────────────────────
    await withGucs(app, adminGucs, async () => {
      ok((await count(app, `UPDATE memory SET content='x' WHERE id=$1`, [MEM_V_A])) === 1, 'team-admin: UPDATE any author in own team ok')
      ok((await count(app, `UPDATE memory SET content='x' WHERE id=$1`, [MEM_B])) === 0, 'team-admin: UPDATE other-team row blocked')
    })

    // ── Global super-admin (is_global_admin) → any team. ────────────────────────
    await withGucs(app, globalGucs, async () => {
      ok((await count(app, `UPDATE memory SET content='x' WHERE id=$1`, [MEM_B])) === 1, 'global-admin: UPDATE other-team row ok')
      let inserted = false
      try { await app.query(`INSERT INTO memory (id, team_id, project, content, category, shape, entities, embedding_status, created_at, updated_at) VALUES (gen_random_uuid(),$1,'general','c','gotcha','gotcha_fix','{}','pending',now(),now())`, [TEAM_B]); inserted = true } catch { inserted = false }
      ok(inserted, 'global-admin: INSERT into any team ok')
    })

    // ── No GUCs set → fail-closed. ──────────────────────────────────────────────
    await withGucs(app, {}, async () => {
      ok((await count(app, 'SELECT 1 FROM memory')) === 0, 'no GUCs: SELECT returns 0 rows (fail-closed)')
      let blocked = false
      try { await app.query(`INSERT INTO memory (id, team_id, project, content, category, shape, entities, embedding_status, created_at, updated_at) VALUES (gen_random_uuid(),$1,'general','c','gotcha','gotcha_fix','{}','pending',now(),now())`, [TEAM_A]) } catch { blocked = true }
      ok(blocked, 'no GUCs: INSERT blocked (fail-closed)')
    })

    // ── A non-memory data table: universal read, cross-team write blocked. ───────
    await withGucs(app, memberGucs, async () => {
      ok((await count(app, 'SELECT 1 FROM source')) >= 0, 'source: universal read query runs')
      let blocked = false
      try { await app.query(`INSERT INTO source (id, team_id, project, kind, created_at, updated_at) VALUES (gen_random_uuid(),$1,'general','document',now(),now())`, [TEAM_B]) } catch { blocked = true }
      ok(blocked, 'source: cross-team INSERT blocked (write_floor)')
    })

    // ── security_alert: read is NOT universal (own-team only), unlike source. ────
    // Scope counts to OUR fixtures (the live dev DB may hold real alerts from other
    // teams created by integration runs — only the fixture rows are deterministic).
    await withGucs(app, memberGucs, async () => {
      ok((await count(app, 'SELECT 1 FROM security_alert WHERE id = ANY($1)', [[ALERT_A, ALERT_B]])) === 1, 'security_alert: member reads OWN team fixture only (1), NOT team B (non-universal)')
      let blocked = false
      try { await app.query(`INSERT INTO security_alert (id, team_id, source_kind, detector, finding_type, created_at, updated_at) VALUES (gen_random_uuid(),$1,'memory','presidio','US_SSN',now(),now())`, [TEAM_B]) } catch { blocked = true }
      ok(blocked, 'security_alert: cross-team INSERT blocked (write_floor)')
    })
    await withGucs(app, globalGucs, async () => {
      ok((await count(app, 'SELECT 1 FROM security_alert WHERE id = ANY($1)', [[ALERT_A, ALERT_B]])) === 2, 'security_alert: global super-admin reads BOTH teams\' fixtures (cross-team)')
    })
    await withGucs(app, {}, async () => {
      ok((await count(app, 'SELECT 1 FROM security_alert')) === 0, 'security_alert: no GUCs → 0 rows (fail-closed)')
    })
  } finally {
    await owner.query(`DELETE FROM security_alert WHERE id = ANY($1)`, [[ALERT_A, ALERT_B]]).catch(() => {})
    await owner.query(`DELETE FROM memory WHERE id = ANY($1)`, [[MEM_U_A, MEM_V_A, MEM_B]]).catch(() => {})
    await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[USER_U, USER_V]]).catch(() => {})
    await owner.query(`DELETE FROM team WHERE id = ANY($1)`, [[TEAM_A, TEAM_B]]).catch(() => {})
    await app.end()
    await owner.end()
  }
  console.log(`\n${failures === 0 ? '✓ RLS floor verified' : `✗ ${failures} assertion(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
