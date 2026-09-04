/**
 * persistent-memory — LIVE integration suite: provisioning helpers.
 *
 * Everything is provisioned THROUGH THE REAL API using the bootstrap super-admin
 * token (PM_BOOTSTRAP_TOKEN, the show-once token the seed prints), so the suite
 * also exercises the admin control plane. NO @pm/db, NO argon2, NO direct DB.
 *
 * Route shapes matched verbatim against:
 *   • POST   /dashboard/teams                 — api/src/routes/dashboard/teams.ts  (body {name} → TeamOut)
 *   • POST   /dashboard/users                 — api/src/routes/dashboard/users.ts  (body {teamId,email?,displayName?} → UserOut)
 *   • PATCH  /dashboard/users/:id/admin-level — api/src/routes/dashboard/users.ts  (body {adminLevel} → UserOut)
 *   • POST   /dashboard/users/:id/token       — api/src/routes/dashboard/tokens.ts (body {expiresAt?} → {tokenId,wireToken,expiresAt})
 *   • POST   /dashboard/grants                — api/src/routes/dashboard/grants.ts (body {grantorTeamId,granteeTeamId} → GrantOut)
 *   • DELETE /dashboard/users/:id             — api/src/routes/dashboard/users.ts  (body {confirm:true} → 204)
 *   • DELETE /dashboard/teams/:id             — api/src/routes/dashboard/teams.ts  (body {confirm:true} → 204)
 *   • DELETE /dashboard/grants                — api/src/routes/dashboard/grants.ts (body {grantorTeamId,granteeTeamId} → 204)
 *   • DELETE /dashboard/memories              — api/src/routes/dashboard/memories.ts (body {teamId,project?,confirm:true} → {deleted}, super-admin only)
 */
import { api } from './client.ts'

/** The bootstrap super-admin wire token (team-less global super-admin). */
export function bootstrapToken(): string {
  if (process.env.PM_ALLOW_LIVE_INTEGRATION !== '1' || process.env.PM_TEST_STACK !== '1') {
    throw new Error(
      'PM_ALLOW_LIVE_INTEGRATION=1 and PM_TEST_STACK=1 are required because this suite mutates data. ' +
        'Run `npm run dev-test:run`; it verifies the disposable stack before tests begin.',
    )
  }
  const t = process.env.PM_BOOTSTRAP_TOKEN
  if (!t) {
    throw new Error(
      'PM_BOOTSTRAP_TOKEN is required — the show-once bootstrap super-admin token ' +
        'printed by the install seed. See test/integration/README.md.',
    )
  }
  return t
}

export interface Team {
  id: string
  name: string
}

export interface AdminUser {
  id: string
  teamId: string | null
  adminLevel: 'none' | 'admin' | 'superuser'
}

/** A provisioned member: the user row + their freshly minted wire token. */
export interface ProvisionedMember extends AdminUser {
  token: string
}

/** A unique-ish suffix so parallel CI runs / reruns don't collide on names/emails. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createTeam(adminToken: string, name: string): Promise<Team> {
  const res = await api<{ id: string; name: string }>('POST', '/dashboard/teams', {
    token: adminToken,
    body: { name },
  })
  if (res.status !== 201) {
    throw new Error(`createTeam(${name}) failed: ${res.status} ${JSON.stringify(res.json)}`)
  }
  return { id: res.json.id, name: res.json.name }
}

/** Create a plain member (adminLevel 'none') in a team. No token yet. */
export async function createUser(
  adminToken: string,
  teamId: string,
  opts: { email?: string; displayName?: string } = {},
): Promise<AdminUser> {
  const res = await api<{ id: string; teamId: string | null; adminLevel: AdminUser['adminLevel'] }>(
    'POST',
    '/dashboard/users',
    { token: adminToken, body: { teamId, ...opts } },
  )
  if (res.status !== 201) {
    throw new Error(`createUser(team=${teamId}) failed: ${res.status} ${JSON.stringify(res.json)}`)
  }
  return { id: res.json.id, teamId: res.json.teamId, adminLevel: res.json.adminLevel }
}

/** Issue (mint) a user's wire token — returned ONCE in the body. */
export async function issueToken(adminToken: string, userId: string): Promise<string> {
  const res = await api<{ tokenId: string; wireToken: string; expiresAt: string | null }>(
    'POST',
    `/dashboard/users/${userId}/token`,
    { token: adminToken, body: {} },
  )
  if (res.status !== 201) {
    throw new Error(`issueToken(${userId}) failed: ${res.status} ${JSON.stringify(res.json)}`)
  }
  return res.json.wireToken
}

/** Superuser-only escalation: set a user's admin_level. */
export async function setAdminLevel(
  adminToken: string,
  userId: string,
  adminLevel: AdminUser['adminLevel'],
): Promise<void> {
  const res = await api('PATCH', `/dashboard/users/${userId}/admin-level`, {
    token: adminToken,
    body: { adminLevel },
  })
  if (res.status !== 200) {
    throw new Error(
      `setAdminLevel(${userId}, ${adminLevel}) failed: ${res.status} ${JSON.stringify(res.json)}`,
    )
  }
}

/**
 * Create a directional read-grant ("mount"): grantor's data becomes readable by
 * grantee. TeamGrant(grantor, grantee) — i.e. grantee mounts grantor. Idempotent
 * server-side (P2002 → returns the existing grant).
 */
export async function createGrant(
  adminToken: string,
  grantorTeamId: string,
  granteeTeamId: string,
): Promise<void> {
  const res = await api('POST', '/dashboard/grants', {
    token: adminToken,
    body: { grantorTeamId, granteeTeamId },
  })
  if (res.status !== 201) {
    throw new Error(
      `createGrant(grantor=${grantorTeamId}, grantee=${granteeTeamId}) failed: ` +
        `${res.status} ${JSON.stringify(res.json)}`,
    )
  }
}

/**
 * Convenience: create a team, a member in it, mint their token. Returns the team
 * + the member (with token). `label` differentiates names/emails across teams.
 */
export async function provisionTeamWithMember(
  adminToken: string,
  label: string,
): Promise<{ team: Team; member: ProvisionedMember }> {
  const sfx = uniqueSuffix()
  const team = await createTeam(adminToken, `it-${label}-${sfx}`)
  const user = await createUser(adminToken, team.id, {
    email: `it-${label}-${sfx}@example.test`,
    displayName: `IT ${label} ${sfx}`,
  })
  const token = await issueToken(adminToken, user.id)
  return { team, member: { ...user, token } }
}

// ── Teardown (best-effort; never throws — afterAll should not mask failures) ───

export async function deleteUser(adminToken: string, userId: string): Promise<void> {
  await api('DELETE', `/dashboard/users/${userId}`, {
    token: adminToken,
    body: { confirm: true },
  }).catch(() => {})
}

/**
 * Purge a team's memories via the super-admin dashboard bulk delete, so the team
 * has no data rows and DELETE /dashboard/teams (which refuses non-empty teams with
 * 409 team_not_empty) can succeed. Requires a super-admin token.
 */
export async function purgeTeamMemories(adminToken: string, teamId: string): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await api<{ results: Array<{ id: string }>; nextCursor: string | null }>('GET', '/dashboard/memories', {
      token: adminToken,
      query: { teamId, limit: 200, ...(cursor ? { cursor } : {}) },
    }).catch(() => null)
    if (!page || page.status !== 200) return
    for (const row of page.json.results) {
      const preview = await api<{ token: string }>('POST', `/dashboard/memories/${row.id}/delete-preview`, { token: adminToken }).catch(() => null)
      if (!preview || preview.status !== 200) continue
      await api('DELETE', `/dashboard/memories/${row.id}`, {
        token: adminToken,
        body: { previewToken: preview.json.token },
      }).catch(() => {})
    }
    cursor = page.json.nextCursor ?? undefined
  } while (cursor)
}

export async function deleteTeam(adminToken: string, teamId: string): Promise<void> {
  await api('DELETE', `/dashboard/teams/${teamId}`, {
    token: adminToken,
    body: { confirm: true },
  }).catch(() => {})
}

export async function deleteGrant(
  adminToken: string,
  grantorTeamId: string,
  granteeTeamId: string,
): Promise<void> {
  await api('DELETE', '/dashboard/grants', {
    token: adminToken,
    body: { grantorTeamId, granteeTeamId },
  }).catch(() => {})
}

/**
 * Full teardown for a provisioned team + member: delete the member, purge the
 * team's memories (so it's empty), then delete the team. Best-effort throughout.
 *
 * NOTE: ingest also creates Source/Document/Chunk rows that the team-delete
 * presence-probe counts — those teams cannot be auto-deleted by this helper
 * while data remains, which is expected and harmless (the team row lingers; its
 * RLS isolation is unaffected). The memory-only specs clean up fully.
 */
export async function teardownTeamWithMember(
  adminToken: string,
  team: Team,
  member: AdminUser,
): Promise<void> {
  await purgeTeamMemories(adminToken, team.id)
  await deleteUser(adminToken, member.id)
  await deleteTeam(adminToken, team.id)
}
