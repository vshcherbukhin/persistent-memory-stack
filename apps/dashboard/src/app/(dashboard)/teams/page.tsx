import { requireControlPlane } from '@/lib/session'
import { api } from '@/lib/api'
import { TeamsClient } from './TeamsClient'

export const dynamic = 'force-dynamic'

export default async function TeamsPage() {
  await requireControlPlane()
  const teams = await api.listTeams()

  return <TeamsClient teams={teams} />
}
