'use server'

import { revalidatePath } from 'next/cache'
import { api } from '@/lib/api'

/**
 * Self-service profile server actions (P1) — back the ProfileModal. Update name/email
 * and set/clear the optional local password through the typed JSON client, then
 * revalidate the dashboard layout so the nav name refreshes.
 */
export interface ProfileActionState {
  ok?: boolean
  error?: string
  recoveryToken?: string
  /** Bumps on each result so the client can react even when ok repeats. */
  nonce?: number
}

export async function updateProfileAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const displayName = String(formData.get('displayName') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const currentPassword = String(formData.get('currentPassword') ?? '')
  const password = String(formData.get('password') ?? '')
  const removePassword = formData.get('removePassword') === 'on' || formData.get('removePassword') === 'true'

  const body: { displayName?: string | null; email?: string | null; currentPassword?: string; password?: string; removePassword?: boolean } = {
    displayName: displayName || null,
    email: email || null,
  }
  if (removePassword) body.removePassword = true
  else if (password) {
    if (currentPassword) body.currentPassword = currentPassword
    body.password = password
  }

  try {
    const updated = await api.updateProfile(body)
    revalidatePath('/', 'layout')
    return { ok: true, recoveryToken: updated.recoveryToken, nonce: Date.now() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Update failed', nonce: Date.now() }
  }
}
