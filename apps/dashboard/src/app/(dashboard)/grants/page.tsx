import { requireControlPlane } from '@/lib/session'
import { api } from '@/lib/api'
import { GrantMatrix } from '@/components/GrantMatrix'

export const dynamic = 'force-dynamic'

export default async function GrantsPage() {
  await requireControlPlane()
  const { teams, grants } = await api.getGrants()

  return (
    <GrantMatrix teams={teams} grants={grants} />
  )
}
