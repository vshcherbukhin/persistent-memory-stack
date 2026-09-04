'use server'

import { revalidatePath } from 'next/cache'
import { api, ApiError } from '@/lib/api'
import { requireControlPlane } from '@/lib/session'

export interface IssueState {
  /** The wire token, present ONLY on a successful mint — shown ONCE, never
   * re-fetchable. The client renders it in a copy modal then discards it. */
  wireToken?: string
  tokenId?: string
  expiresAt?: string | null
  error?: string
  /** Bumped each call so the client can detect a fresh result. */
  nonce?: number
}

function parseExpiry(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Issue OR rotate (rotate=true) a user's token. Returns the wire token ONCE. */
export async function issueTokenAction(
  _prev: IssueState,
  formData: FormData,
): Promise<IssueState> {
  await requireControlPlane()
  const id = String(formData.get('id'))
  const rotate = String(formData.get('rotate') ?? '') === 'true'
  const expiresAt = parseExpiry(formData.get('expiresAt'))
  try {
    const issued = rotate
      ? await api.rotateToken(id, expiresAt)
      : await api.issueToken(id, expiresAt)
    revalidatePath('/tokens')
    return {
      wireToken: issued.wireToken,
      tokenId: issued.tokenId,
      expiresAt: issued.expiresAt,
      nonce: Date.now(),
    }
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Failed to issue token.'
    return { error: message, nonce: Date.now() }
  }
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  await requireControlPlane()
  const id = String(formData.get('id'))
  await api.revokeToken(id)
  revalidatePath('/tokens')
}
