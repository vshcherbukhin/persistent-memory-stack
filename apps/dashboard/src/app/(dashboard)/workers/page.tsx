import { requireSession, isSuperuser } from '@/lib/session'
import { listWorkersAction } from './actions'
import { WorkersClient } from './WorkersClient'

export const dynamic = 'force-dynamic'

/**
 * Workers — the managed scheduled-job monitor. Any valid session may VIEW jobs
 * (schedule + status + next-run + worker liveness) and logs read-only;
 * pause/resume/run-now and schedule edits stay superuser-only (canControl). Backed
 * by the API's /dashboard/workers (BullMQ job-schedulers + the ScheduledJob table). The
 * Rows auto-refresh and surface status/log detail directly in the table.
 */
export default async function WorkersPage() {
  const who = await requireSession()
  const initial = await listWorkersAction()
  return (
    <WorkersClient
      initial={initial.workers}
      initialLiveness={initial.liveness}
      initialError={initial.error}
      canControl={isSuperuser(who)}
    />
  )
}
