'use server'

import { revalidatePath } from 'next/cache'
import { api, normalizeMemorySurface } from '@/lib/api'
import { requireControlPlane } from '@/lib/session'

/**
 * Resolve a security alert. admin+ baseline (requireControlPlane); the server's
 * RLS scopes the write — a team-admin resolving another team's alert matches 0
 * rows (404), so cross-team writes are impossible regardless of the UI.
 */
export async function resolveAlertAction(formData: FormData): Promise<boolean> {
  await requireControlPlane()
  const id = String(formData.get('id') ?? '')
  const surface = normalizeMemorySurface(String(formData.get('surface') ?? 'personal'))
  if (!id) return false
  try {
    await api.resolveSecurityAlert(id, surface)
  } catch {
    return false
  }
  revalidatePath('/security')
  return true
}
