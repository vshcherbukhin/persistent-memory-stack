/**
 * persistent-memory-api — token verification + identity derivation (Phase 3).
 *
 * Token wire format: `<tokenId>.<secret>` (minted by layers/core/schema/seed.ts; later by
 * the dashboard API). Verification is O(1): split on the FIRST '.', look the user up
 * by the indexed @unique tokenId, then a SINGLE argon2id verify of
 * `secret + TOKEN_PEPPER` against the stored tokenHash. Never scan rows running
 * argon2 per candidate — that is a DoS and a timing oracle.
 *
 * ALL reads here hit the CONTROL table app_user, which lives OUTSIDE RLS and to
 * which pm_app has NO grant. So they use `ownerPrisma` (pmuser), not the
 * data-plane `prisma`. This is the #1 trap: using the pm_app client for the
 * token lookup → permission denied → every request 500s.
 */
import { randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import { ownerPrisma, type AppUser, type TenantCtx } from '@pm/db'
import { config } from '../config.ts'
import { isDashboardSessionToken, verifyDashboardSession } from './dashboard-session.ts'

const BEARER = /^Bearer\s+(.+)$/i

// ── Token minting (Phase 9 dashboard API) ────────────────────────────────────────
//
// Issue / rotate / revoke the per-user opaque token. The minting recipe is kept
// in LOCKSTEP with layers/core/schema/seed.ts (tokenId = b64url(8), secret = b64url(32),
// hash = argon2id(secret + TOKEN_PEPPER)) so the bootstrap token and admin-issued
// tokens verify through the SAME verifyToken() above. The wire token is returned
// to the caller ONCE and NEVER persisted (only tokenId + tokenHash live in the
// DB) — the route hands it to the show-once modal and must not log it.
//
// All writes hit the CONTROL table app_user → ownerPrisma (pm_app has no grant).

/** argon2id params — read at call time so env overrides apply (match seed.ts). */
function argonOptions(): argon2.Options {
  return {
    type: argon2.argon2id,
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
  }
}

/** base64url random bytes (URL-safe, no padding). */
function b64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

export interface IssuedToken {
  tokenId: string
  /** The full wire token `${tokenId}.${secret}` — returned ONCE, never stored. */
  wireToken: string
  expiresAt: Date | null
}

/**
 * issueToken / rotateToken — mint a FRESH tokenId + secret for the user, store
 * tokenId + argon2id(tokenHash) + tokenExpires, and return the wire token once.
 * Issue (first grant) and rotate (overwrite an existing token; the old one stops
 * verifying because tokenId changed) are the SAME operation; rotate is just the
 * name used when a token already exists. Throws if the user does not exist
 * (Prisma P2025) — the route maps that to 404.
 */
export async function issueToken(
  userId: string,
  expiresAt: Date | null,
): Promise<IssuedToken> {
  const tokenId = b64url(8) // public, indexed @unique lookup handle
  const secret = b64url(32) // never persisted in plaintext
  const tokenHash = await argon2.hash(secret + config.TOKEN_PEPPER, argonOptions())

  await ownerPrisma.appUser.update({
    where: { id: userId },
    data: { tokenId, tokenHash, tokenExpires: expiresAt, tokenIssuedAt: new Date() },
  })

  return { tokenId, wireToken: `${tokenId}.${secret}`, expiresAt }
}

/**
 * revokeToken — invalidate the user's token by NULLing the hash (and tokenId so
 * the @unique handle is freed). The user row + audit survive; verifyToken denies
 * a NULL-hash user. Idempotent. Throws P2025 if the user does not exist.
 */
export async function revokeToken(userId: string): Promise<void> {
  await ownerPrisma.appUser.update({
    where: { id: userId },
    data: { tokenId: null, tokenHash: null, tokenExpires: null, tokenIssuedAt: null },
  })
}

/** Split a raw wire token on the FIRST '.' only. Returns null if malformed. */
export function parseToken(
  raw: string | undefined,
): { tokenId: string; secret: string } | null {
  if (!raw) return null
  const dot = raw.indexOf('.')
  if (dot <= 0 || dot === raw.length - 1) return null
  return { tokenId: raw.slice(0, dot), secret: raw.slice(dot + 1) }
}

/** Strip a `Bearer ` prefix from an Authorization header value. */
export function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = BEARER.exec(authHeader)
  return m ? m[1]!.trim() : undefined
}

/**
 * verifyToken — resolve the Authorization header to an AppUser, or null.
 * Null on: missing/malformed header, unknown tokenId, revoked (NULL hash),
 * expired, or a failed argon2id verify. Never throws to the caller — a malformed
 * stored hash is treated as a denial (401), not a 500.
 */
export async function verifyToken(
  authHeader: string | undefined,
): Promise<AppUser | null> {
  const parsed = parseToken(extractBearer(authHeader))
  if (!parsed) return null

  const user = await ownerPrisma.appUser.findUnique({
    where: { tokenId: parsed.tokenId },
  })
  if (!user || !user.tokenHash) return null // unknown or revoked (hash NULLed)
  if (user.tokenExpires && user.tokenExpires.getTime() <= Date.now()) return null

  let ok = false
  try {
    ok = await argon2.verify(user.tokenHash, parsed.secret + config.TOKEN_PEPPER)
  } catch {
    return null // malformed/garbage stored hash → deny, do not surface a 500
  }
  return ok ? user : null
}

/**
 * resolveMountedTeams — the teams the given team has MOUNTED = grantor teams of
 * TeamGrants where granteeTeamId == this team. These are the cross-team MEMORY
 * reads the MCP exposes as "additional" (own team is primary). De-duped, own
 * excluded. Control-table read → ownerPrisma (no RLS / tenant context needed).
 */
export async function resolveMountedTeams(ownTeamId: string): Promise<string[]> {
  const grants = await ownerPrisma.teamGrant.findMany({
    where: { granteeTeamId: ownTeamId }, // grants where MY team is the grantee (mounts)
    select: { grantorTeamId: true },
  })
  // Annotate the row shape explicitly — the Prisma 7 generated conditional types
  // collapse a `findMany({ select })` element to `unknown` under an explicit
  // return annotation; pinning it keeps `.map` typed.
  const grantors = (grants as { grantorTeamId: string }[])
    .map((g) => g.grantorTeamId)
    .filter((t) => t !== ownTeamId)
  return [...new Set(grantors)]
}

/**
 * deriveIdentity — the full server-derived TenantCtx from an Authorization
 * header, or null if the token is invalid. teamId may be null (a team-less
 * independent super-admin); mountedTeamIds carries the team's cross-team MEMORY
 * read links (the MCP's "additional" scope). docs/internal/users_roles.md.
 */
export async function deriveIdentity(
  authHeader: string | undefined,
): Promise<TenantCtx | null> {
  const raw = extractBearer(authHeader)
  const user = raw && isDashboardSessionToken(raw)
    ? await verifyDashboardSession(raw)
    : await verifyToken(authHeader)
  if (!user) return null

  const mountedTeamIds = user.teamId ? await resolveMountedTeams(user.teamId) : []

  return {
    userId: user.id,
    teamId: user.teamId, // may be null
    adminLevel: user.adminLevel,
    isTeamMember: user.teamId !== null,
    isTeamAdmin: user.adminLevel === 'admin',
    isGlobalSuperuser: user.adminLevel === 'superuser',
    mountedTeamIds,
    insideTenantTx: false,
  }
}
