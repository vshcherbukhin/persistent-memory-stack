'use server'

import { revalidatePath } from 'next/cache'
import { api, ApiError } from '@/lib/api'
import { requireControlPlane } from '@/lib/session'

/**
 * Toggle a directional read grant. DIRECTIONALITY (locked): a grant
 * (grantor=X, grantee=Y) means "X's data is readable by Y" → cell (row=X, col=Y).
 * `on=true` creates it (idempotent), `on=false` deletes it. Self-grants
 * (grantor===grantee) are rejected server-side (400) and impossible in the UI
 * (the diagonal is disabled).
 */
export async function toggleGrantAction(formData: FormData): Promise<void> {
  await requireControlPlane()
  const grantorTeamId = String(formData.get('grantorTeamId'))
  const granteeTeamId = String(formData.get('granteeTeamId'))
  const on = String(formData.get('on')) === 'true'
  if (!grantorTeamId || !granteeTeamId || grantorTeamId === granteeTeamId) return
  try {
    if (on) await api.setGrant(grantorTeamId, granteeTeamId)
    else await api.unsetGrant(grantorTeamId, granteeTeamId)
  } catch (err) {
    // A delete of a non-existent grant is a 404 (grant_not_found) — benign for a
    // toggle (already off). Re-throw anything else.
    if (err instanceof ApiError && err.code === 'grant_not_found') {
      // already in desired state
    } else if (err instanceof ApiError) {
      throw new Error(err.message)
    } else {
      throw err
    }
  }
  revalidatePath('/grants')
}
