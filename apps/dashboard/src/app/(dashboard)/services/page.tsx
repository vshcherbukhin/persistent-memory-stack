import { requireSession, isSuperuser } from '@/lib/session'
import { canAccessControlPlane } from '@/lib/authz'
import { listServicesAction } from './actions'
import { ServicesClient } from './ServicesClient'

export const dynamic = 'force-dynamic'

/**
 * Services — the local stack monitor. Any valid session may VIEW state + health
 * + logs; stack start/stop stays superuser-only (canControl), while MCP session
 * rows are client-owned and expose logs only. Lists every container's state + health and tails logs. Works in
 * server-managed embeddings and client-managed embeddings. Backed by the API's /dashboard/services over the Docker socket;
 * if the socket isn't mounted the page shows the degraded notice.
 */
export default async function ServicesPage() {
  const who = await requireSession()
  const initial = await listServicesAction()
  return (
    <ServicesClient
      initial={initial.services}
      initialClients={initial.mcpClients}
      initialCapabilityHealth={initial.capabilityHealth}
      initialError={initial.error}
      canControl={isSuperuser(who)}
      canViewCredentials={canAccessControlPlane(who.adminLevel)}
    />
  )
}
