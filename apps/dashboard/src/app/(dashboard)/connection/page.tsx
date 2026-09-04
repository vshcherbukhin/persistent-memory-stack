import { requireControlPlane } from '@/lib/session'
import { api } from '@/lib/api'
import { SharedConnectionForm } from '@/components/SharedConnectionForm'
import type { SharedConnectionStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

const EMPTY_CONNECTION: SharedConnectionStatus = {
  configured: false,
  apiUrl: null,
  tokenConfigured: false,
  connectedAt: null,
  checkedAt: null,
  remoteConfig: null,
  remoteIdentity: null,
  compatibility: null,
}

export default async function ConnectionPage() {
  const who = await requireControlPlane()
  if (who.deploymentMode !== 'local') {
    return (
      <div className="page-scroll">
        <div className="notice danger">
          Shared Memories Server connection is managed from the local personal dashboard.
        </div>
      </div>
    )
  }

  const current = await api.getSharedConnection().catch(() => EMPTY_CONNECTION)

  return (
    <div className="page-scroll connection-page">
      <div className="panel">
        <SharedConnectionForm current={current} />
      </div>
    </div>
  )
}
