/**
 * /dashboard/* — the canonical dashboard/control-plane route aggregator.
 * /admin/* remains a compatibility alias for one release.
 *
 * Registered as ONE encapsulated Fastify scope in app.ts AFTER the data-secured
 * scope. It reuses the same authenticate + enterTenantScope onRequest hooks (to
 * get req.identity). The CONTROL surface (teams/users/tokens/grants/settings/
 * memories) is wrapped in an inner scope that applies requireAdmin as a
 * SCOPE-LEVEL preHandler so every control route inherits the baseline gate;
 * requireSuperuser is added per-route on the escalation ops (PATCH .../admin-level,
 * PUT /settings).
 *
 * The OPERATIONAL READS (Services list/logs + Usage metrics + Workers list/logs)
 * are registered OUTSIDE that inner scope: they are org-wide, non-team-data reads
 * that ANY authenticated user may view (the dashboard shows them to members too).
 * They still inherit authenticate + enterTenantScope, just not requireAdmin. The
 * MUTATIONS among them — POST /dashboard/services/:service/:action and the
 * /dashboard/workers pause/resume/run-now/edit ops — keep their own per-route
 * requireSuperuser (they change what runs on the server). So admin_level still
 * grants ZERO write access here; it only gates the control tables.
 *
 * Control-table handlers (teams/users/tokens/settings) use ownerPrisma (those
 * tables are OUTSIDE RLS and pm_app has no grant). The dashboard memory surface
 * (memories) uses runInTenant with the global-admin RLS path.
 *
 * The grant subsystem is retired — reads are universal (docs/internal/users_roles.md).
 */
import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../../authz/guards.ts'
import { dashboardTeamRoutes } from './teams.ts'
import { dashboardUserRoutes } from './users.ts'
import { dashboardTokenRoutes } from './tokens.ts'
import { dashboardGrantRoutes } from './grants.ts'
import { dashboardSettingsRoutes } from './settings.ts'
import { dashboardMemoryRoutes } from './memories.ts'
import { dashboardOverviewRoutes } from './overview.ts'
import { dashboardSecurityAlertRoutes } from './security-alerts.ts'
import { dashboardNotifySettingsRoutes } from './notify-settings.ts'
import { dashboardServiceRoutes } from './services.ts'
import { dashboardUsageRoutes } from './usage.ts'
import { dashboardWorkerRoutes } from './workers.ts'
import { dashboardUpdateRoutes } from './update.ts'
import { dashboardSharedConnectionRoutes } from './shared-connection.ts'
import { dashboardBrowserPushRoutes } from './browser-push.ts'

const CONTROL_PREFIXES = ['/dashboard', '/admin'] as const

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // CONTROL surface — admin+ baseline. Per-route requireSuperuser is layered on
  // top in users.ts (admin-level) and settings.ts (PUT).
  await app.register(async (control) => {
    control.addHook('preHandler', requireAdmin)
    for (const prefix of CONTROL_PREFIXES) {
      await control.register(dashboardOverviewRoutes, { prefix })
      await control.register(dashboardTeamRoutes, { prefix })
      await control.register(dashboardUserRoutes, { prefix })
      await control.register(dashboardTokenRoutes, { prefix })
      await control.register(dashboardGrantRoutes, { prefix }) // "mounts" — cross-team MCP memory reads
      await control.register(dashboardSettingsRoutes, { prefix })
      await control.register(dashboardMemoryRoutes, { prefix })
      await control.register(dashboardSecurityAlertRoutes, { prefix }) // DLP findings (own-team / super=all)
      await control.register(dashboardNotifySettingsRoutes, { prefix }) // per-team + global alert routing
      await control.register(dashboardSharedConnectionRoutes, { prefix }) // local dashboard connector to one shared server
      await control.register(dashboardBrowserPushRoutes, { prefix }) // local personal browser Web Push subscriptions
    }
  })

  // OPERATIONAL reads — any authenticated user (NO requireAdmin). The Services
  // POST keeps its own per-route requireSuperuser; Usage is read-only.
  for (const prefix of CONTROL_PREFIXES) {
    await app.register(dashboardServiceRoutes, { prefix }) // local stack monitor (Docker socket)
    await app.register(dashboardUpdateRoutes, { prefix }) // snapshot-safe stack updater
    await app.register(dashboardUsageRoutes, { prefix }) // model-usage metrics (Usage page)
    await app.register(dashboardWorkerRoutes, { prefix }) // managed scheduled-worker control plane
  }
}
