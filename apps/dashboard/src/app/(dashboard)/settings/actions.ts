'use server'

import { revalidatePath } from 'next/cache'
import { api, ApiError, ForbiddenError } from '@/lib/api'
import { requireControlPlane, isSuperuser } from '@/lib/session'
import type { DashboardLoginMode, EmbeddingMode, SettingsTestResult, SharedConnectionTestResult } from '@/lib/types'

export interface SettingsState {
  ok?: boolean
  modelChanged?: boolean
  switchStarted?: boolean
  warning?: string
  error?: string
  nonce?: number
}

export interface SharedConnectionState extends SettingsState {
  tested?: SharedConnectionTestResult
}

async function restartMcpStreamBestEffort(): Promise<string | undefined> {
  try {
    await api.serviceAction('mcp', 'restart')
    return undefined
  } catch (err) {
    return err instanceof ApiError ? err.message : 'MCP stream restart failed; restart it from Services.'
  }
}

function factExtractionInput(model: string, apiKey: string): { model: string; apiKey?: string } {
  return apiKey.trim() ? { model, apiKey: apiKey.trim() } : { model }
}

export async function saveMcpSessionTimeoutAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { error: 'MCP session timeout is superuser-only.', nonce: Date.now() }
  const minutes = Number(formData.get('mcpSessionIdleTimeoutMinutes'))
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return { error: 'Session timeout must be a whole number from 1 to 1440 minutes.', nonce: Date.now() }
  }
  try {
    await api.putMcpSessionTimeout({ mcpSessionIdleTimeoutSeconds: minutes * 60 })
    const warning = await restartMcpStreamBestEffort()
    revalidatePath('/settings')
    revalidatePath('/services')
    return { ok: true, warning, nonce: Date.now() }
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: 'Forbidden — superuser required.', nonce: Date.now() }
    return { error: err instanceof ApiError ? err.message : 'Failed to save MCP session timeout.', nonce: Date.now() }
  }
}

export async function saveDashboardLoginModeAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { error: 'Dashboard login settings are superuser-only.', nonce: Date.now() }
  const mode = String(formData.get('dashboardLoginMode') ?? '') as DashboardLoginMode
  if (mode !== 'password' && mode !== 'sso') {
    return { error: 'Choose password or SSO login mode.', nonce: Date.now() }
  }
  try {
    await api.putDashboardLoginMode(mode)
    revalidatePath('/settings')
    revalidatePath('/login')
    return { ok: true, nonce: Date.now() }
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: 'Forbidden — superuser required.', nonce: Date.now() }
    return { error: err instanceof ApiError ? err.message : 'Failed to save dashboard login mode.', nonce: Date.now() }
  }
}

export async function testSharedConnectionAction(input: {
  apiUrl: string
  token: string
}): Promise<SharedConnectionTestResult | { ok: false; message: string }> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { ok: false, message: 'Shared connection testing is superuser-only.' }
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
  if (!isSuperuser(who)) return { error: 'Shared connection settings are superuser-only.', nonce: Date.now() }
  const apiUrl = String(formData.get('sharedApiUrl') ?? '').trim()
  const token = String(formData.get('sharedToken') ?? '').trim()
  if (!apiUrl || !token) return { error: 'Shared API URL and connector token are required.', nonce: Date.now() }
  try {
    await api.saveSharedConnection({ apiUrl, token })
    const warning = await restartMcpStreamBestEffort()
    revalidatePath('/settings')
    revalidatePath('/memories')
    return { ok: true, warning, nonce: Date.now() }
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: 'Forbidden — superuser required.', nonce: Date.now() }
    return { error: err instanceof ApiError ? err.message : 'Failed to save shared connection.', nonce: Date.now() }
  }
}

export async function disconnectSharedConnectionAction(
  _prev: SharedConnectionState,
  _formData: FormData,
): Promise<SharedConnectionState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { error: 'Shared connection settings are superuser-only.', nonce: Date.now() }
  try {
    await api.disconnectSharedConnection()
    const warning = await restartMcpStreamBestEffort()
    revalidatePath('/settings')
    revalidatePath('/memories')
    return { ok: true, warning, nonce: Date.now() }
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: 'Forbidden — superuser required.', nonce: Date.now() }
    return { error: err instanceof ApiError ? err.message : 'Failed to disconnect shared memories.', nonce: Date.now() }
  }
}

export async function testEmbeddingAction(input: {
  activeEmbedModel: string
  activeEmbedDim: number
}): Promise<SettingsTestResult> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) {
    return { ok: false, model: input.activeEmbedModel, message: 'Embedding test is superuser-only.' }
  }
  try {
    return await api.testEmbedding(input)
  } catch (err) {
    return {
      ok: false,
      model: input.activeEmbedModel,
      message: 'Embedding test failed.',
      details: 'The API did not return a completed result. Check capability health and try again.',
    }
  }
}

export async function testFactExtractionAction(input: {
  model: string
  apiKey?: string
}): Promise<SettingsTestResult> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) {
    return { ok: false, model: input.model, message: 'Fact extraction test is superuser-only.' }
  }
  try {
    return await api.testFactExtraction(input)
  } catch (err) {
    return {
      ok: false,
      model: input.model,
      message: 'Fact extraction test failed.',
      details: 'The API did not return a completed result. Check capability health and try again.',
    }
  }
}

export async function saveFactExtractionAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) {
    return { error: 'Fact extraction settings are superuser-only.', nonce: Date.now() }
  }
  const model = String(formData.get('factExtractionModel') ?? '').trim()
  const apiKey = String(formData.get('factExtractionApiKey') ?? '')
  const manuallyTested = String(formData.get('factExtractionTested') ?? '') === 'true'
  if (!model) return { error: 'Fact extraction model is required.', nonce: Date.now() }

  try {
    if (!manuallyTested) {
      const test = await api.testFactExtraction(factExtractionInput(model, apiKey))
      if (!test.ok) {
        return {
          error: `Fact extraction test failed: ${test.message}${test.details ? ` ${test.details}` : ''}`,
          nonce: Date.now(),
        }
      }
    }
    await api.putFactExtraction(factExtractionInput(model, apiKey))
    revalidatePath('/settings')
    revalidatePath('/')
    return { ok: true, nonce: Date.now() }
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { error: 'Forbidden — superuser required.', nonce: Date.now() }
    }
    return {
      error: err instanceof ApiError ? err.message : 'Failed to save fact extraction settings.',
      nonce: Date.now(),
    }
  }
}

/**
 * Save system settings. SUPERUSER-ONLY (server gate: requireSuperuser on PUT
 * /dashboard/settings). We defend in depth here too. A model/dim change is NOT a
 * live toggle — the server returns modelChanged + a re-embed warning, which we
 * surface verbatim. A server-managed/client-managed topology flip with the same pin is data-safe.
 */
export async function saveSettingsAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) {
    return { error: 'System settings are superuser-only.', nonce: Date.now() }
  }
  const embeddingMode = String(formData.get('embeddingMode')) as EmbeddingMode
  const activeEmbedModel = String(formData.get('activeEmbedModel') ?? '').trim()
  const activeEmbedDim = Number(formData.get('activeEmbedDim'))
  if (!activeEmbedModel || !Number.isInteger(activeEmbedDim) || activeEmbedDim <= 0) {
    return { error: 'Model is required and dim must be a positive integer.', nonce: Date.now() }
  }

  try {
    const res = await api.putSettings({ embeddingMode, activeEmbedModel, activeEmbedDim })
    revalidatePath('/settings')
    revalidatePath('/')
    return {
      ok: true,
      modelChanged: res.modelChanged,
      switchStarted: res.switchStarted,
      warning: res.warning,
      nonce: Date.now(),
    }
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { error: 'Forbidden — superuser required.', nonce: Date.now() }
    }
    const message =
      err instanceof ApiError
        ? err.code === 'validation_failed'
          ? err.message // unknown model / bad (model,dim) pair
          : err.message
        : 'Failed to save settings.'
    return { error: message, nonce: Date.now() }
  }
}
