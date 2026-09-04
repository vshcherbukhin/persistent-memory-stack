'use server'

import { revalidatePath } from 'next/cache'
import { api, ApiError } from '@/lib/api'
import { requireControlPlane, isSuperuser } from '@/lib/session'
import type { AdminLevel } from '@/lib/types'

export async function createUserAction(formData: FormData): Promise<void> {
  await requireControlPlane()
  const teamId = String(formData.get('teamId'))
  const email = String(formData.get('email') ?? '').trim()
  const displayName = String(formData.get('displayName') ?? '').trim()
  if (!teamId) return
  try {
    await api.createUser({ teamId, email: email || undefined, displayName: displayName || undefined })
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
  revalidatePath('/users')
}

/** Update team membership + profile. adminLevel is NOT settable here — the
 * server's generic PATCH omits it (the escalation firewall). */
export async function updateUserAction(formData: FormData): Promise<void> {
  await requireControlPlane()
  const id = String(formData.get('id'))
  const teamId = String(formData.get('teamId'))
  try {
    await api.updateUser(id, { teamId })
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
  revalidatePath('/users')
}

/**
 * Assign admin_level. SUPERUSER-ONLY: the server gate is requireSuperuser; we
 * defend in depth here so a non-superuser session can never reach the endpoint
 * even if the (disabled) control were forced. The server may 409 last_superuser
 * when demoting the final superuser — re-thrown as a readable error.
 */
export async function setAdminLevelAction(formData: FormData): Promise<void> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) {
    throw new Error('Only a superuser may assign admin_level.')
  }
  const id = String(formData.get('id'))
  const adminLevel = String(formData.get('adminLevel')) as AdminLevel
  try {
    await api.setAdminLevel(id, adminLevel)
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message) // last_superuser, etc.
    throw err
  }
  revalidatePath('/users')
}

export async function deleteUserAction(formData: FormData): Promise<void> {
  await requireControlPlane()
  const id = String(formData.get('id'))
  try {
    await api.deleteUser(id)
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
  revalidatePath('/users')
}

export interface ResetPasswordState {
  ok?: boolean
  password?: string
  error?: string
  nonce?: number
}

export async function resetUserPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) {
    return { error: 'Only a superuser may reset passwords.', nonce: Date.now() }
  }
  const id = String(formData.get('id'))
  if (!id) return { error: 'Missing user id.', nonce: Date.now() }
  try {
    const res = await api.resetUserPassword(id)
    revalidatePath('/users')
    return { ok: true, password: res.password, nonce: Date.now() }
  } catch (err) {
    return {
      error: err instanceof ApiError ? err.message : 'Password reset failed.',
      nonce: Date.now(),
    }
  }
}
