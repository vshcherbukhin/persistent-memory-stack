'use server'

import { revalidatePath } from 'next/cache'
import { api } from '@/lib/api'

export interface RenameState {
  ok?: boolean
  error?: string
}

/** Rename the (single) local team. The local user is a superuser, so the control-plane
 * team rename is permitted; revalidate so the header team name refreshes. */
export async function renameTeamAction(_prev: RenameState, formData: FormData): Promise<RenameState> {
  const id = String(formData.get('teamId') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!id) return { error: 'No team id.' }
  if (!name) return { error: 'Enter a team name.' }
  try {
    await api.renameTeam(id, name)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Rename failed' }
  }
  revalidatePath('/', 'layout')
  revalidatePath('/team-settings')
  return { ok: true }
}
