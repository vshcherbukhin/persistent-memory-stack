/**
 * Scenario H — embedding-model switch DONE RIGHT (Phase 10, #5).
 *
 * Against the running Mode-A stack, drive a real dim switch end-to-end from the
 * admin control plane and assert NO BLACKOUT + search on the new pin:
 *   1. baseline — a memory is searchable on the current pin.
 *   2. PUT /dashboard/settings with a different (supported) dim → modelChanged +
 *      switchStarted; the response still reports the OLD pin (active until flip).
 *   3. poll until embeddingSwitch.state==='done' — then the active pin + vector name
 *      reflect the TARGET, and the SAME memory is still searchable (re-embedded).
 *   4. switch BACK to the original pin (also via the live driver) so the shared
 *      stack is left exactly as found for the other spec files.
 *
 * This spec mutates GLOBAL state (the one shared collection), so the suite's
 * sequential runner (fileParallelism:false) is load-bearing; the restore in step 4
 * makes it order-independent. The MCP mismatch-guidance path (#4, Mode B) is covered
 * deterministically by the MCP unit test — not re-asserted against a Mode-A stack.
 *
 * SKIPS itself unless the live pin is Mode A on qwen3-embedding:4b (both 2560 and
 * 1024 are registry-supported truncation dims of that model, so the switch needs no
 * extra Ollama pull). On any other pin it logs + passes (no false red).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api, poll } from './client.ts'
import {
  bootstrapToken,
  provisionTeamWithMember,
  teardownTeamWithMember,
  uniqueSuffix,
  type Team,
  type ProvisionedMember,
} from './provision.ts'

const admin = bootstrapToken()
const PROJECT = `it-switch-${uniqueSuffix()}`
const ENTITY = `component_switch_widget`

interface Settings {
  embeddingMode: 'server' | 'client-bridge'
  activeEmbedModel: string
  activeEmbedDim: number
  activeVectorName: string
  embeddingSwitch: { state: 'running' | 'done' | 'failed'; migrated: number; error?: string } | null
}
type PutResult = Settings & { modelChanged: boolean; switchStarted?: boolean; warning?: string }

let team: Team
let member: ProvisionedMember
let memId = ''
let original: { model: string; dim: number } | null = null
let target: { model: string; dim: number } | null = null
let runnable = false

const content = `[${ENTITY}] The model-switch widget broke during the integration run. Root cause: a stale pin. Fix: re-embed under the new pin. Prevention: drive the switch tool end to end.`

/** Switch the pin via the live driver, then poll to a terminal state. */
async function switchTo(model: string, dim: number): Promise<Settings> {
  const put = await api<PutResult>('PUT', '/dashboard/settings', {
    token: admin,
    body: { embeddingMode: 'server', activeEmbedModel: model, activeEmbedDim: dim },
  })
  expect(put.status, JSON.stringify(put.json)).toBe(200)
  expect(put.json.modelChanged).toBe(true)
  expect(put.json.switchStarted).toBe(true)
  // Until the flip the API still reports the OLD pin (no premature blackout).
  expect(put.json.activeEmbedDim).not.toBe(dim)

  const done = await poll(
    () => api<Settings>('GET', '/dashboard/settings', { token: admin }),
    (r) => r.json.embeddingSwitch?.state === 'done' || r.json.embeddingSwitch?.state === 'failed',
    { timeoutMs: 90_000, intervalMs: 1_500 },
  )
  expect(done.json.embeddingSwitch?.state, JSON.stringify(done.json.embeddingSwitch)).toBe('done')
  return done.json
}

beforeAll(async () => {
  const cur = await api<Settings>('GET', '/dashboard/settings', { token: admin })
  if (cur.status === 200 && cur.json.embeddingMode === 'server' && cur.json.activeEmbedModel === 'qwen3-embedding:4b') {
    original = { model: cur.json.activeEmbedModel, dim: cur.json.activeEmbedDim }
    target = { model: 'qwen3-embedding:4b', dim: original.dim === 2560 ? 1024 : 2560 }
    runnable = true
    const p = await provisionTeamWithMember(admin, 'switch')
    team = p.team
    member = p.member
  } else {
    console.warn(
      `[model-switch.test] SKIP — live pin is ${cur.json?.embeddingMode}/${cur.json?.activeEmbedModel}; ` +
        'this scenario needs Mode A on qwen3-embedding:4b.',
    )
  }
})

afterAll(async () => {
  // Restore the original pin so other spec files see the stack as they expect.
  if (runnable && original) {
    const now = await api<Settings>('GET', '/dashboard/settings', { token: admin })
    if (now.json.activeEmbedModel !== original.model || now.json.activeEmbedDim !== original.dim) {
      await switchTo(original.model, original.dim).catch(() => {})
    }
    await teardownTeamWithMember(admin, team, member)
  }
})

describe('Phase-10 embedding-model switch (no blackout, search on new pin)', () => {
  it('baseline — the memory is searchable on the current pin', async () => {
    if (!runnable) return
    const add = await api<{ id: string }>('POST', '/memories', {
      token: member.token,
      body: { content, project: PROJECT, metadata: { category: 'gotcha', entities: [ENTITY], source: 'gotcha-discovered', severity: 'medium' } },
    })
    expect(add.status, JSON.stringify(add.json)).toBe(201)
    memId = add.json.id

    const search = await api<{ results: Array<{ id: string }> }>('POST', '/memories/search', {
      token: member.token,
      body: { query: 'model switch widget re-embeds', project: PROJECT, limit: 20 },
    })
    expect(search.status).toBe(200)
    expect(search.json.results.some((r) => r.id === memId), 'memory found pre-switch').toBe(true)
  })

  it('switches the pin live → done, new vector name, memory re-embedded + searchable', async () => {
    if (!runnable || !target) return
    const after = await switchTo(target.model, target.dim)
    expect(after.activeEmbedDim).toBe(target.dim)
    expect(after.activeVectorName).toContain(String(target.dim))
    expect(after.embeddingSwitch?.migrated).toBeGreaterThan(0)

    const search = await api<{ results: Array<{ id: string }> }>('POST', '/memories/search', {
      token: member.token,
      body: { query: 'model switch widget re-embeds', project: PROJECT, limit: 20 },
    })
    expect(search.status).toBe(200)
    expect(search.json.results.some((r) => r.id === memId), 'memory found on the NEW pin (no blackout)').toBe(true)
  })

  it('switches back to the original pin → still searchable', async () => {
    if (!runnable || !original) return
    const back = await switchTo(original.model, original.dim)
    expect(back.activeEmbedDim).toBe(original.dim)

    const search = await api<{ results: Array<{ id: string }> }>('POST', '/memories/search', {
      token: member.token,
      body: { query: 'model switch widget re-embeds', project: PROJECT, limit: 20 },
    })
    expect(search.status).toBe(200)
    expect(search.json.results.some((r) => r.id === memId), 'memory found after switch-back').toBe(true)
  })
})
