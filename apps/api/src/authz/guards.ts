/**
 * persistent-memory-api — deny-by-default authorization guards.
 *
 * The access model is docs/internal/users_roles.md (it supersedes the old
 * "control ≠ data" invariant). Two orthogonal dimensions: team membership
 * (none, or exactly one team) and admin_level (none/admin/superuser).
 *
 *   • DATA plane  (/memories/*, the MCP)        → decideDataPlane.
 *       Reads are UNIVERSAL (any team member searches any team). Writes are
 *       CURRENT-TEAM ONLY for everyone (even super-admins — cross-team is
 *       dashboard-only); a plain member may only edit/delete OWN-created rows;
 *       a team-admin/super-admin may edit/delete ANY author in their team.
 *       Team-less callers are rejected entirely.
 *   • DASHBOARD plane (/dashboard/memories/*)       → decideDashboard.
 *       super-admin → CRUD any memory of any team. team-admin → CRUD any author
 *       in OWN team, other teams read-only. member → not allowed (admin+).
 *   • CONTROL plane (/dashboard/teams|users|...)    → decideAdmin / decideSuperuser.
 *
 * The fine-grained data decisions depend on the TARGET row's team + author,
 * which the preHandler can't see — so handlers call decideDataPlane/
 * decideDashboard AFTER a findUnique, and RLS is the DB-level backstop. The
 * preHandlers here do only the coarse gate (authenticated / has-team / admin+).
 * Guards and handlers MUST NEVER read a team/teamId from the request body.
 */
import type { preHandlerHookHandler } from 'fastify'
import type { AdminLevel } from '@pm/db'
import { unauthorized, forbidden, ForbiddenError, AuthError } from './errors.ts'

// ── Pure decision functions (no Fastify, no DB) — directly unit-testable. ────

export type GuardDecision = { ok: true } | { ok: false; error: AuthError | ForbiddenError }

const ALLOW: GuardDecision = { ok: true }
const deny = (code: string, message: string): GuardDecision => ({
  ok: false,
  error: forbidden(code, message),
})

/** Memory data-plane actions. */
export type DataAction = 'create' | 'update' | 'delete' | 'search'

/** The server-derived identity subset the decisions need (a TenantCtx is one). */
export interface DecisionIdentity {
  userId: string
  /** Own team, or null for a team-less (independent) super-admin. */
  teamId: string | null
  adminLevel: AdminLevel
  isTeamMember: boolean
  isTeamAdmin: boolean
  isGlobalSuperuser: boolean
}

/** The target row for an update/delete decision (its team + author). */
export interface MemoryTarget {
  teamId: string
  createdById: string | null
}

export interface DecisionInput {
  identity: DecisionIdentity
  action: DataAction
  /** Required for update/delete; absent for create/search. */
  target?: MemoryTarget
}

/**
 * decideDataPlane — the "Memory MCP security guard" (users_roles.md). Writes are
 * current-team only for EVERYONE; super-admin's cross-team reach is dashboard-only.
 */
export function decideDataPlane({ identity: i, action, target }: DecisionInput): GuardDecision {
  // Team-less callers cannot use the data plane at all (the MCP requires a team).
  if (!i.isTeamMember || i.teamId === null) {
    return deny(
      'no_team',
      'Data-plane memory operations require team membership. A team-less ' +
        'super-admin manages memories on the dashboard, not through the MCP.',
    )
  }

  if (action === 'search') return ALLOW // universal read
  if (action === 'create') return ALLOW // current team; author + team stamped server-side

  // update | delete — needs the target row.
  if (!target) return deny('target_required', 'Update/delete requires the target memory.')

  // Current-team only — even a super-admin cannot cross teams on the data plane.
  if (target.teamId !== i.teamId) {
    return deny(
      'cross_team_denied',
      'Memory writes are current-team only here. Cross-team changes are ' +
        'dashboard-only (admin/super-admin).',
    )
  }

  // Within the current team: admin/super-admin → any author; member → own only.
  if (i.isTeamAdmin || i.isGlobalSuperuser) return ALLOW
  if (target.createdById !== null && target.createdById === i.userId) return ALLOW
  return deny('not_owner', 'You may only edit or delete memories you created.')
}

/**
 * allowUniversalRead — the universal (all-teams) fan-out gate for the DATA-PLANE
 * POST /memories/search route. `decideDataPlane` returns ALLOW for search, but
 * that "universal read" is own ∪ mounted (RLS-scoped). The all-teams fan-out is a
 * SEPARATE escalation driven by the body `universal` flag, and it is admin-only:
 * a plain member's `universal:true` is IGNORED → own ∪ mounted (mounts are how a
 * member is granted cross-team reads). The dashboard's true all-teams view goes
 * through /dashboard/memories (decideDashboard), never this route. Returns true only
 * when the body asked for universal AND the caller is admin+ (admin or superuser).
 */
export function allowUniversalRead(adminLevel: AdminLevel, requested: boolean | undefined): boolean {
  return requested === true && adminLevel !== 'none'
}

/**
 * decideDashboard — elevated /dashboard/memories/* rules. super-admin = any team;
 * team-admin = own team only (other teams read-only); member = denied.
 */
export function decideDashboard({ identity: i, action, target }: DecisionInput): GuardDecision {
  if (action === 'search') {
    return i.adminLevel !== 'none'
      ? ALLOW
      : deny('admin_required', 'Dashboard memory management requires admin_level in {admin, superuser}.')
  }

  // Super-admin: full CRUD on any memory of any team.
  if (i.isGlobalSuperuser) return ALLOW

  // Team-admin: own team only.
  if (i.isTeamAdmin) {
    if (i.teamId === null) return deny('no_team', 'An admin must be team-bound.')
    if (action === 'create') {
      // Own team only — no target defaults to own team upstream; an explicit
      // target team must match (mirrors the update/delete read-only rule).
      return !target || target.teamId === i.teamId
        ? ALLOW
        : deny('cross_team_read_only', 'Admins may only create memories in their own team; other teams are read-only.')
    }
    if (!target) return deny('target_required', 'Update/delete requires the target memory.')
    return target.teamId === i.teamId
      ? ALLOW
      : deny('cross_team_read_only', 'Admins may only modify their own team; other teams are read-only.')
  }

  return deny('admin_required', 'Dashboard memory management requires admin_level in {admin, superuser}.')
}

export function decideAdmin(adminLevel: AdminLevel): GuardDecision {
  if (adminLevel !== 'admin' && adminLevel !== 'superuser') {
    return deny('admin_required', 'Control-plane operations require admin_level in {admin, superuser}.')
  }
  return ALLOW
}

export function decideSuperuser(adminLevel: AdminLevel): GuardDecision {
  if (adminLevel !== 'superuser') {
    return deny(
      'superuser_required',
      'This operation is superuser-only — admins cannot create or modify ' +
        'super-admins (privilege-escalation guard).',
    )
  }
  return ALLOW
}

/** Data-plane membership gate: the caller must belong to a team. */
export function decideTeamMember(i: Pick<DecisionIdentity, 'isTeamMember' | 'teamId'>): GuardDecision {
  if (!i.isTeamMember || i.teamId === null) {
    return deny(
      'no_team',
      'Data-plane memory operations require team membership. A team-less ' +
        'super-admin manages memories on the dashboard, not through the MCP.',
    )
  }
  return ALLOW
}

// ── Fastify preHandler adapters over the pure decisions. ─────────────────────

function applyDecision(
  req: { identity?: DecisionIdentity },
  decide: (id: DecisionIdentity) => GuardDecision,
): void {
  const id = req.identity
  if (!id) throw unauthorized() // fail-closed: no identity → 401, never open
  const decision = decide(id)
  if (!decision.ok) throw decision.error
}

/** DATA-plane gate: the caller must belong to a team (per-row checks in handler). */
export const requireTeamMember: preHandlerHookHandler = async (req, _reply) => {
  applyDecision(req, (id) => decideTeamMember(id))
}

/** CONTROL-plane: admin or superuser. */
export const requireAdmin: preHandlerHookHandler = async (req, _reply) => {
  applyDecision(req, (id) => decideAdmin(id.adminLevel))
}

/** CONTROL-plane escalation: superuser ONLY (manage super-admins / assign admin_level). */
export const requireSuperuser: preHandlerHookHandler = async (req, _reply) => {
  applyDecision(req, (id) => decideSuperuser(id.adminLevel))
}
