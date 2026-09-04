/**
 * Local deployment mode (Phase 13, #Part5) — the DB-backed single super-user.
 *
 * When DEPLOYMENT_MODE=local the api authenticates NO token: every request is the
 * SAME single super-user who is a MEMBER of one seeded team. That identity is read
 * from the `local_identity` singleton, which points at real generated DB rows. That
 * makes local mode work through the SAME paths as a normal authed super-admin-with-team — the data
 * plane (requireTeamMember passes; current-team = the local team), RLS (team_write
 * on the local team_id), and the dashboard all behave normally. NO RLS change, NO
 * global-admin sentinel — the local user is just a real, seeded row.
 *
 * ensureLocalIdentity creates the team/user rows on first boot and records their
 * generated ids in `local_identity` (idempotent), so local mode is self-contained —
 * no token issued, no dependency on the bootstrap seed having run with a flag.
 *
 * P1 (full-local redesign): the team NAME + the user's email/displayName/password come
 * from the onboarding "account" step (via LOCAL_* env). Reinstalls over preserved DB
 * volumes may re-apply the onboarding password only when the installer's
 * LOCAL_USER_PASSWORD_CONFIGURED_AT is newer than app_user.password_changed_at. Later
 * profile/team-settings edits (incl. removing the password) remain the source of truth.
 *
 * SECURITY: this module's behavior is gated entirely by config.DEPLOYMENT_MODE at
 * BOOT (app.ts selects authenticateLocal only when local). Nothing here runs in
 * server mode.
 */
import { ownerPrisma, type TenantCtx } from '@pm/db'
import { config } from '../config.ts'
import { hashPassword } from './password.ts'

const LOCAL_IDENTITY_ID = 'singleton'
// Default team name = the wizard's placeholder ("QA"), so a blank LOCAL_TEAM_NAME yields
// "QA" rather than a "local-mode" tag. 'local-mode' is the LEGACY placeholder from
// pre-P1 installs — still treated as upgradeable so it gets renamed to the resolved name.
const DEFAULT_TEAM_NAME = 'QA'
const LEGACY_TEAM_PLACEHOLDER = 'local-mode'
const DEFAULT_DISPLAY_NAME = 'Local Super User'

/** Team name from the onboarding answer, else the "QA" default. */
function localTeamName(): string {
  return config.LOCAL_TEAM_NAME.trim() || DEFAULT_TEAM_NAME
}

/** A team name we may auto-upgrade to the resolved name (never a user-chosen name). */
function isPlaceholderTeamName(name: string): boolean {
  return name === DEFAULT_TEAM_NAME || name === LEGACY_TEAM_PLACEHOLDER
}

/** Display name: explicit answer → email local-part → default. */
function localDisplayName(): string {
  const name = config.LOCAL_USER_DISPLAY_NAME.trim()
  if (name) return name
  // Guard the empty local-part (e.g. "@host" → "") so the fallback chain reaches the default.
  const local = config.LOCAL_USER_EMAIL.trim().split('@')[0]?.trim()
  if (local) return local
  return DEFAULT_DISPLAY_NAME
}

type LocalIdentityRow = {
  teamId: string
  userId: string
  user: {
    id: string
    teamId: string | null
    adminLevel: 'none' | 'admin' | 'superuser'
    passwordHash: string | null
    passwordTemporary: boolean
    passwordChangedAt: Date | null
  }
}

function tenantCtxFromLocalRow(row: LocalIdentityRow): TenantCtx {
  const teamId = row.user.teamId ?? row.teamId
  const adminLevel = row.user.adminLevel
  return {
    userId: row.user.id,
    teamId,
    adminLevel,
    isTeamMember: !!teamId,
    isTeamAdmin: adminLevel === 'admin',
    isGlobalSuperuser: adminLevel === 'superuser',
    mountedTeamIds: [],
    insideTenantTx: false,
  }
}

async function readLocalIdentityRow(): Promise<LocalIdentityRow | null> {
  return ownerPrisma.localIdentity.findUnique({
    where: { id: LOCAL_IDENTITY_ID },
    select: {
      teamId: true,
      userId: true,
      user: { select: { id: true, teamId: true, adminLevel: true, passwordHash: true, passwordTemporary: true, passwordChangedAt: true } },
    },
  })
}

function installerPasswordConfiguredAt(): Date | null {
  const raw = config.LOCAL_USER_PASSWORD_CONFIGURED_AT.trim()
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function passwordSyncTime(row: LocalIdentityRow): Date | null {
  const configuredAt = installerPasswordConfiguredAt()
  if (configuredAt) {
    if (!row.user.passwordChangedAt || row.user.passwordChangedAt.getTime() < configuredAt.getTime()) return configuredAt
    return null
  }

  // Legacy migration path: older installers wrote LOCAL_USER_PASSWORD without a timestamp
  // and first-boot rows did not set password_changed_at. Apply the env value once, then
  // stamp password_changed_at so future restarts preserve dashboard profile changes.
  if (!row.user.passwordChangedAt && config.LOCAL_USER_PASSWORD) return new Date()
  return null
}

async function syncLocalPasswordFromEnv(row: LocalIdentityRow): Promise<void> {
  const passwordChangedAt = passwordSyncTime(row)
  if (!passwordChangedAt) return
  await ownerPrisma.appUser.update({
    where: { id: row.userId },
    data: {
      passwordHash: config.LOCAL_USER_PASSWORD ? await hashPassword(config.LOCAL_USER_PASSWORD) : null,
      passwordTemporary: false,
      passwordChangedAt,
    },
  })
}

async function upgradePlaceholderTeamName(teamId: string): Promise<void> {
  const team = await ownerPrisma.team.findUnique({ where: { id: teamId }, select: { name: true } })
  const resolvedTeam = localTeamName()
  if (team && isPlaceholderTeamName(team.name) && team.name !== resolvedTeam) {
    await ownerPrisma.team.update({ where: { id: teamId }, data: { name: resolvedTeam } })
  }
}

async function repairLocalUser(row: LocalIdentityRow): Promise<void> {
  const data: Record<string, unknown> = {}
  if (row.user.teamId !== row.teamId) data.teamId = row.teamId
  if (row.user.adminLevel !== 'superuser') data.adminLevel = 'superuser'
  if (Object.keys(data).length > 0) {
    await ownerPrisma.appUser.update({ where: { id: row.userId }, data })
  }
}

async function adoptExistingLocalSuperuser(): Promise<LocalIdentityRow | null> {
  const user = await ownerPrisma.appUser.findFirst({
    where: { adminLevel: 'superuser', teamId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, teamId: true, adminLevel: true, passwordHash: true, passwordTemporary: true, passwordChangedAt: true },
  })
  if (!user?.teamId) return null
  await ownerPrisma.localIdentity.create({
    data: { id: LOCAL_IDENTITY_ID, teamId: user.teamId, userId: user.id },
  })
  await upgradePlaceholderTeamName(user.teamId)
  const row = { teamId: user.teamId, userId: user.id, user }
  await syncLocalPasswordFromEnv(row)
  return row
}

/**
 * Upsert the local team + super-user (control tables → ownerPrisma) so the injected
 * identity references real rows. Idempotent; call once at api boot in local mode,
 * BEFORE listening (no request can race it). No token is set (tokenId/tokenHash
 * stay null) — local mode never authenticates via token.
 *
 * SEED-OR-NEWER-INSTALLER: the team name + the user's displayName/email come from the
 * onboarding answer only on first creation. The password is also applied to an existing
 * local identity when the installer timestamp is newer than the dashboard profile's
 * password_changed_at, which makes reinstalling with preserved memories honor the
 * password just typed in the wizard without clobbering later profile changes.
 */
export async function ensureLocalIdentity(): Promise<TenantCtx> {
  const existing = await readLocalIdentityRow()
  if (existing) {
    await upgradePlaceholderTeamName(existing.teamId)
    await repairLocalUser(existing)
    await syncLocalPasswordFromEnv(existing)
    const repaired = await readLocalIdentityRow()
    return tenantCtxFromLocalRow(repaired ?? existing)
  }

  const adopted = await adoptExistingLocalSuperuser()
  if (adopted) return tenantCtxFromLocalRow(adopted)

  // First local install: let the DB/Prisma generate IDs, then remember those real
  // row IDs in the local_identity singleton. If the resolved team name already
  // exists, reuse it instead of inventing a duplicate.
  const team = await ownerPrisma.team.upsert({
    where: { name: localTeamName() },
    update: {},
    create: { name: localTeamName() },
    select: { id: true },
  })
  const email = config.LOCAL_USER_EMAIL.trim() || null
  const hash = config.LOCAL_USER_PASSWORD ? await hashPassword(config.LOCAL_USER_PASSWORD) : null
  const configuredAt = installerPasswordConfiguredAt()
  const user = await ownerPrisma.appUser.create({
    data: {
      teamId: team.id,
      adminLevel: 'superuser',
      displayName: localDisplayName(),
      email,
      passwordHash: hash,
      passwordTemporary: false,
      passwordChangedAt: configuredAt ?? (hash ? new Date() : null),
    },
    select: { id: true, teamId: true, adminLevel: true, passwordHash: true, passwordTemporary: true, passwordChangedAt: true },
  })
  await ownerPrisma.localIdentity.create({
    data: { id: LOCAL_IDENTITY_ID, teamId: team.id, userId: user.id },
  })
  return tenantCtxFromLocalRow({ teamId: team.id, userId: user.id, user })
}

/**
 * The server-derived identity injected on every request in local mode. It is read
 * from the database so local mode always uses the actual seeded user/team rows.
 */
export async function localIdentity(): Promise<TenantCtx> {
  const row = await readLocalIdentityRow()
  if (row) return tenantCtxFromLocalRow(row)
  return ensureLocalIdentity()
}

/** Password hash for the optional local dashboard lock. */
export async function localPasswordHash(): Promise<string | null> {
  const row = await ownerPrisma.localIdentity.findUnique({
    where: { id: LOCAL_IDENTITY_ID },
    select: { user: { select: { passwordHash: true } } },
  })
  if (row) return row.user.passwordHash
  await ensureLocalIdentity()
  const created = await ownerPrisma.localIdentity.findUnique({
    where: { id: LOCAL_IDENTITY_ID },
    select: { user: { select: { passwordHash: true } } },
  })
  return created?.user.passwordHash ?? null
}
