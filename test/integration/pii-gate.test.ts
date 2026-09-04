/**
 * Scenario F — the DLP/PII write-gate + Security plane (Phase 8, #10).
 *
 * Against the running stack (api + worker + the dlp sidecar — Presidio + gitleaks):
 *   1. A memory whose content passes the Shape pre-gate but contains a credit card
 *      is BLOCKED → 422 pii_detected (Presidio). The payload is redaction-safe.
 *   2. A memory containing a GitHub token is BLOCKED → 422 pii_detected (gitleaks).
 *   3. A clean memory still writes (201) — the gate doesn't false-positive.
 *   4. /dashboard/security-alerts: admin reads (200); a plain member is 403 (requireAdmin).
 *   5. /dashboard/notify-settings: the global row round-trips (super-admin).
 *
 * The gate runs BEFORE the Stage-2 LLM, so a PII reject is a 422 with
 * error:'pii_detected' (distinct from the Shape gate's 'validation_failed').
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api } from './client.ts'
import {
  bootstrapToken,
  provisionTeamWithMember,
  teardownTeamWithMember,
  uniqueSuffix,
  type Team,
  type ProvisionedMember,
} from './provision.ts'

const admin = bootstrapToken()
const PROJECT = `it-pii-${uniqueSuffix()}`
const ENTITY = `config_secret_store`
let team: Team
let member: ProvisionedMember

// All three pass the Shape pre-gate (entity token, ≥40 chars, category/entities/source,
// verbatim entity) so the DLP gate (Stage 1.5) is what decides. The PII/secret values
// are reliably-detected fixtures: a Luhn-valid Visa test card (Presidio CREDIT_CARD)
// and a real-format GitHub PAT (gitleaks github-pat). (AWS *example* keys are
// allowlisted by gitleaks; bare SSNs score low — so we use high-signal fixtures.)
const PII_VALUE = '4111111111111111'
const SECRET_VALUE = 'ghp_wWPw5k4aXcaT4fNP0UcnZwJjcg9kZM0123ab'
const CARD_CONTENT = `[${ENTITY}] The config secret store logged card ${PII_VALUE} during setup. Root cause: missing redaction. Fix: redact. Prevention: scan inputs.`
const SECRET_CONTENT = `[${ENTITY}] The config secret store committed token ${SECRET_VALUE} in the setup script. Root cause: hardcoded creds. Fix: use env. Prevention: gitleaks.`
const CLEAN_CONTENT = `[${ENTITY}] The config secret store rejected a malformed entry during setup. Root cause: loose parsing. Fix: validate. Prevention: schema check.`

const meta = { category: 'gotcha', entities: [ENTITY], source: 'gotcha-discovered', severity: 'medium' }

beforeAll(async () => {
  const p = await provisionTeamWithMember(admin, 'pii')
  team = p.team
  member = p.member
})

afterAll(async () => {
  await teardownTeamWithMember(admin, team, member)
})

describe('Phase-8 DLP/PII write-gate', () => {
  it('BLOCKS a memory containing a credit card (Presidio) → 422 pii_detected', async () => {
    const res = await api<{ error: string; findings?: { finding_type: string }[] }>('POST', '/memories', {
      token: member.token,
      body: { content: CARD_CONTENT, project: PROJECT, metadata: meta },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(422)
    expect(res.json.error).toBe('pii_detected')
    // Redaction-safe: the raw card number must never be echoed back.
    expect(JSON.stringify(res.json)).not.toContain(PII_VALUE)
  })

  it('BLOCKS a memory containing a GitHub token (gitleaks) → 422 pii_detected', async () => {
    const res = await api<{ error: string }>('POST', '/memories', {
      token: member.token,
      body: { content: SECRET_CONTENT, project: PROJECT, metadata: meta },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(422)
    expect(res.json.error).toBe('pii_detected')
    expect(JSON.stringify(res.json)).not.toContain(SECRET_VALUE)
  })

  it('ALLOWS a clean memory (no false positive)', async () => {
    const res = await api<{ id: string; error?: string }>('POST', '/memories', {
      token: member.token,
      body: { content: CLEAN_CONTENT, project: PROJECT, metadata: meta },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.id).toBeTruthy()
    await api('DELETE', `/memories/${res.json.id}`, { token: member.token }).catch(() => {})
  })
})

describe('Phase-8 Security plane', () => {
  it('admin can read /dashboard/security-alerts', async () => {
    const res = await api<{ alerts: unknown[] }>('GET', '/dashboard/security-alerts', { token: admin })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(Array.isArray(res.json.alerts)).toBe(true)
  })

  it('a plain member cannot read /dashboard/security-alerts (requireAdmin)', async () => {
    const res = await api('GET', '/dashboard/security-alerts', { token: member.token })
    expect(res.status).toBe(403)
  })

  it('the global notify-settings row round-trips (super-admin)', async () => {
    const put = await api<{ minSeverity: string }>('PUT', '/dashboard/notify-settings/global', {
      token: admin,
      body: { enabled: true, emailRecipients: [], slackWebhookUrl: null, minSeverity: 'medium' },
    })
    expect(put.status, JSON.stringify(put.json)).toBe(200)
    expect(put.json.minSeverity).toBe('medium')

    const get = await api<{ global: { minSeverity: string } | null }>('GET', '/dashboard/notify-settings', { token: admin })
    expect(get.status).toBe(200)
    expect(get.json.global?.minSeverity).toBe('medium')
  })
})
