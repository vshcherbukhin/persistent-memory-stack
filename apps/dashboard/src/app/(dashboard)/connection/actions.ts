'use server'

import { revalidatePath } from 'next/cache'
import { api, ApiError, ForbiddenError } from '@/lib/api'
import { requireControlPlane, isSuperuser } from '@/lib/session'
import type { SharedConnectionTestResult } from '@/lib/types'

export interface SharedConnectionState {
  ok?: boolean
  warning?: string
  error?: string
  nonce?: number
}

async function restartMcpStreamBestEffort(): Promise<string | undefined> {
  try {
    await api.serviceAction('mcp', 'restart')
    return undefined
  } catch (err) {
    return err instanceof ApiError ? err.message : 'MCP stream restart failed; restart it from Services.'
  }
}

export async function testSharedConnectionAction(input: {
  apiUrl: string
  token: string
}): Promise<SharedConnectionTestResult | { ok: false; message: string }> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { ok: false, message: 'Shared connection testing is local dashboard owner-only.' }
  try {
    return await api.testSharedConnection(input)
  } catch (err) {
    return {
      ok: false,
      message: err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Shared connection test failed.',
    }
  }
}

export async function saveSharedConnectionAction(
  _prev: SharedConnectionState,
  formData: FormData,
): Promise<SharedConnectionState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { error: 'Shared connection settings are local dashboard owner-only.', nonce: Date.now() }
  const apiUrl = String(formData.get('sharedApiUrl') ?? '').trim()
  const token = String(formData.get('sharedToken') ?? '').trim()
  if (!apiUrl || !token) return { error: 'Shared Memories Server API URL and connector token are required.', nonce: Date.now() }
  try {
    await api.saveSharedConnection({ apiUrl, token })
    const warning = await restartMcpStreamBestEffort()
    revalidatePath('/connection')
    revalidatePath('/memories')
    revalidatePath('/')
    return { ok: true, warning, nonce: Date.now() }
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: 'Forbidden — local dashboard owner required.', nonce: Date.now() }
    return { error: err instanceof ApiError ? err.message : 'Failed to save shared connection.', nonce: Date.now() }
  }
}

export async function disconnectSharedConnectionAction(
  _prev: SharedConnectionState,
  _formData: FormData,
): Promise<SharedConnectionState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { error: 'Shared connection settings are local dashboard owner-only.', nonce: Date.now() }
  try {
    await api.disconnectSharedConnection()
    const warning = await restartMcpStreamBestEffort()
    revalidatePath('/connection')
    revalidatePath('/memories')
    revalidatePath('/')
    return { ok: true, warning, nonce: Date.now() }
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: 'Forbidden — local dashboard owner required.', nonce: Date.now() }
    return { error: err instanceof ApiError ? err.message : 'Failed to disconnect shared memories.', nonce: Date.now() }
  }
}
