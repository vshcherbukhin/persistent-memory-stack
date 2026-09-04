'use server'

import { revalidatePath } from 'next/cache'
import { api, ApiError } from '@/lib/api'
import { requireControlPlane } from '@/lib/session'

export interface TeamActionState {
  ok?: boolean
  error?: string
  nonce?: number
}

/** All team mutations require an authenticated control-plane session
 * (requireAdmin on the server; requireControlPlane re-checks here). */
async function gate() {
  await requireControlPlane()
}

function errorState(err: unknown, fallback: string): TeamActionState {
  return { error: err instanceof Error ? err.message : fallback, nonce: Date.now() }
}

export async function createTeamAction(_prev: TeamActionState, formData: FormData): Promise<TeamActionState> {
  await gate()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Team name is required.', nonce: Date.now() }
  try {
    await api.createTeam(name)
  } catch (err) {
    return errorState(err, 'Failed to create team.')
  }
  revalidatePath('/teams')
  return { ok: true, nonce: Date.now() }
}

export async function renameTeamAction(_prev: TeamActionState, formData: FormData): Promise<TeamActionState> {
  await gate()
  const id = String(formData.get('id'))
  const name = String(formData.get('name') ?? '').trim()
  if (!id || !name) return { error: 'Team name is required.', nonce: Date.now() }
  try {
    await api.renameTeam(id, name)
  } catch (err) {
    return errorState(err, 'Failed to rename team.')
  }
  revalidatePath('/teams')
  return { ok: true, nonce: Date.now() }
}

/**
 * Delete a team. The server REFUSES a non-empty team (409 team_not_empty) — the
 * FK cascade would destroy its memories. We re-throw that as a readable error so
 * Next renders it on the error boundary; the UI also confirms before submitting.
 */
export async function deleteTeamAction(_prev: TeamActionState, formData: FormData): Promise<TeamActionState> {
  await gate()
  const id = String(formData.get('id'))
  try {
    await api.deleteTeam(id)
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: err.message, nonce: Date.now() } // e.g. "Team has N member(s)…" / "still owns data…"
    }
    return errorState(err, 'Failed to delete team.')
  }
  revalidatePath('/teams')
  return { ok: true, nonce: Date.now() }
}
