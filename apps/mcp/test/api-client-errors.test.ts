/**
 * Unit matrix for the MCP api-client error mapping (Phase 8).
 *
 * The contract: every non-2xx persistent-memory-api response must become an
 * ACTIONABLE, token-free, agent-facing ApiError. This file pins the three
 * load-bearing status classes the task calls out — 422 (Shape-gate + embedding
 * pin), 401 (token), 403 (role / scope) — plus the ApiClient wiring that turns
 * a stubbed fetch Response into the mapped error (and proves the Bearer token is
 * attached as a header and never logged into the thrown text).
 *
 * No network, no real api: fetch is stubbed per-test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, type RejectPayload } from '../src/errors.ts'
import { ApiClient } from '../src/api-client.ts'
import { withMcpRequestContext } from '../src/request-context.ts'

const REJECT_PAYLOAD: RejectPayload = {
  error: 'validation_failed',
  reason: 'content too short and no type-prefixed entity token present',
  missing: ['entity-token-in-text'],
  rewrite_templates: {
    A: '[entity] symptom. Root cause: … Fix: … Prevention: …',
    E: '[entity] fact. Why it matters: …',
  },
  entity_format: 'lowercase snake_case <type>_<specific_name>',
  valid_categories: ['gotcha', 'fix', 'user-correction'],
  valid_sources: ['gotcha-discovered', 'user-correction'],
  your_submission: {
    content_excerpt: 'too short',
    content_length: 9,
    metadata_received: { category: 'gotcha' },
  },
  suggestion: 'add a [entity_token] and expand past 40 chars',
}

const API_URL = 'http://host.docker.internal:8090'

describe('ApiError.fromResponse — 401 (token)', () => {
  it('maps 401 to a re-issue-token + RESTART instruction, never echoing the token', () => {
    const err = ApiError.fromResponse(
      401,
      { error: 'invalid_token', message: 'token revoked' },
      API_URL,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.code).toBe('invalid_token')
    const text = err.toAgentText()
    expect(text).toMatch(/Authentication failed/i)
    expect(text).toMatch(/PM_USER_TOKEN/)
    expect(text).toMatch(/RESTART/i)
    // The upstream message is surfaced but no secret value leaks.
    expect(text).toContain('token revoked')
  })
})

describe('ApiError.fromResponse — 403 (role / scope)', () => {
  it('no_team → team-membership-required guidance', () => {
    const err = ApiError.fromResponse(403, { error: 'no_team' }, API_URL)
    expect(err.status).toBe(403)
    expect(err.code).toBe('no_team')
    const text = err.toAgentText()
    expect(text).toMatch(/requires team membership/i)
    expect(text).toMatch(/dashboard/i)
  })

  it('not_owner → only-edit-your-own guidance', () => {
    const err = ApiError.fromResponse(403, { error: 'not_owner' }, API_URL)
    expect(err.code).toBe('not_owner')
    const text = err.toAgentText()
    expect(text).toMatch(/memories you created/i)
  })

  it('cross_team_denied → current-team-only guidance', () => {
    const err = ApiError.fromResponse(403, { error: 'cross_team_denied' }, API_URL)
    expect(err.code).toBe('cross_team_denied')
    const text = err.toAgentText()
    expect(text).toMatch(/current-team only/i)
  })

  it('scope_not_readable → "narrow not widen" guidance', () => {
    const err = ApiError.fromResponse(403, { error: 'scope_not_readable' }, API_URL)
    expect(err.code).toBe('scope_not_readable')
    const text = err.toAgentText()
    expect(text).toMatch(/Scope rejected/i)
    expect(text).toMatch(/NARROW/i)
  })

  it('unknown 403 code → generic cross-team / role guidance', () => {
    const err = ApiError.fromResponse(403, { error: 'something_else', message: 'nope' }, API_URL)
    expect(err.status).toBe(403)
    const text = err.toAgentText()
    expect(text).toMatch(/Permission denied/i)
    expect(text).toContain('nope')
    expect(text).toMatch(/cross teams/i)
  })
})

describe('ApiError.fromResponse — 400 request shape', () => {
  it('summarizes validation fields without echoing the raw validator payload', () => {
    const err = ApiError.fromResponse(
      400,
      {
        error: 'validation_error',
        issues: [
          { path: ['projects', 0], message: 'Required', received: 'undefined' },
          { path: ['limit'], message: 'Expected number, received string', received: 'all' },
        ],
      },
      API_URL,
    )

    expect(err.toAgentText()).toContain('projects.0: Required')
    expect(err.toAgentText()).toContain('limit: Expected number, received string')
    expect(err.toAgentText()).not.toContain('"received"')
    expect(err.toAgentText()).toContain('Fix only the named field(s) and retry the same tool')
  })
})

describe('ApiError.fromResponse — 422 (Shape gate + embedding pin)', () => {
  it('validation_failed → full RejectPayload rendered as text AND available as structuredContent', () => {
    const err = ApiError.fromResponse(
      422,
      REJECT_PAYLOAD as unknown as Record<string, unknown>,
      API_URL,
    )
    expect(err.status).toBe(422)
    expect(err.code).toBe('validation_failed')

    const text = err.toAgentText()
    expect(text).toMatch(/FAILED the Shape A–E write gate/i)
    expect(text).toMatch(/do NOT resend the same payload/i)
    // The rewrite templates the agent needs are inlined.
    expect(text).toContain(REJECT_PAYLOAD.rewrite_templates.A)
    expect(text).toContain('valid_categories: gotcha, fix, user-correction')

    // The whole payload is carried verbatim for structuredContent.
    const payload = err.rejectPayload()
    expect(payload).toBeDefined()
    expect(payload?.reason).toBe(REJECT_PAYLOAD.reason)
    expect(payload?.rewrite_templates).toEqual(REJECT_PAYLOAD.rewrite_templates)
  })

  it('vector_dim_mismatch → client-managed embedding-pin RESTART guidance', () => {
    const err = ApiError.fromResponse(
      422,
      { error: 'vector_dim_mismatch', message: 'expected 1024 got 768' },
      API_URL,
    )
    expect(err.code).toBe('vector_dim_mismatch')
    const text = err.toAgentText()
    expect(text).toMatch(/Embedding pin mismatch/i)
    expect(text).toMatch(/client-bridge/)
    expect(text).toMatch(/RESTART/i)
    expect(text).toContain('expected 1024 got 768')
    // Not a Shape-gate reject — no structuredContent payload.
    expect(err.rejectPayload()).toBeUndefined()
  })

  it('embedding_pin_mismatch → re-deploy-local-engine + RESTART guidance (P10 #4)', () => {
    const err = ApiError.fromResponse(422, { error: 'embedding_pin_mismatch' }, API_URL)
    expect(err.code).toBe('embedding_pin_mismatch')
    const text = err.toAgentText()
    expect(text).toMatch(/Embedding pin mismatch/i)
    // The admin switched the model → the bridge must re-deploy the local engine
    // with the NEW model and restart; the server can't embed in client-bridge mode.
    expect(text).toMatch(/switched the pinned embedding model/i)
    expect(text).toMatch(/re-deploy your local embedding engine/i)
    expect(text).toMatch(/RESTART/i)
  })

  it('409 upload_conflict → RETRY guidance (concurrent same-filename upload)', () => {
    const err = ApiError.fromResponse(
      409,
      { error: 'upload_conflict', message: 'A concurrent upload of "a.txt" to project "p" is in progress.' },
      API_URL,
    )
    expect(err.status).toBe(409)
    expect(err.code).toBe('upload_conflict')
    const text = err.toAgentText()
    expect(text).toMatch(/RETRY/i)
    expect(text).toMatch(/duplicate/i)
  })

  it('unknown 422 code → generic 422 reject (still no structuredContent)', () => {
    const err = ApiError.fromResponse(422, { error: 'weird', message: 'huh' }, API_URL)
    expect(err.status).toBe(422)
    expect(err.toAgentText()).toMatch(/Request rejected \(422\)/i)
    expect(err.rejectPayload()).toBeUndefined()
  })
})

describe('ApiError.fromResponse — 503 extraction provider transient', () => {
  it('maps fact extraction token exhaustion to the exact non-retryable agent error', () => {
    const err = ApiError.fromResponse(
      503,
      {
        error: 'fact_extraction_quota_exhausted',
        message: 'Fact extraction is out of tokens. The memory was not saved.',
        retryable: false,
      },
      API_URL,
    )

    expect(err.status).toBe(503)
    expect(err.code).toBe('fact_extraction_quota_exhausted')
    expect(err.toAgentText()).toBe('Fact extraction is out of tokens. The memory was not saved.')
  })

  it('maps fact extraction overload to retry guidance without stack-health blame', () => {
    const err = ApiError.fromResponse(
      503,
      {
        error: 'extraction_provider_overloaded',
        message:
          'Fact extraction provider Anthropic is overloaded while validating memory content. Retry shortly; the memory was not saved.',
      },
      API_URL,
    )

    expect(err.status).toBe(503)
    expect(err.code).toBe('extraction_provider_overloaded')
    const text = err.toAgentText()
    expect(text).toMatch(/Fact extraction is temporarily unavailable/i)
    expect(text).toMatch(/memory was not saved/i)
    expect(text).toMatch(/Retry shortly/i)
    expect(text).not.toMatch(/docker compose ps/i)
  })
})

describe('ApiClient — non-2xx fetch becomes the mapped ApiError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stubFetch(status: number, body: unknown): typeof fetch {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fn)
    return fn as unknown as typeof fetch
  }

  const cfg = {
    API_URL,
    PM_USER_TOKEN: 'tok123.secretSECRETsecret',
    PM_API_TIMEOUT_MS: 30_000,
  }

  it('attaches Authorization: Bearer header and maps a 401 body to ApiError', async () => {
    const fetchSpy = stubFetch(401, { error: 'invalid_token' })
    const client = new ApiClient(cfg)

    const err = await client.get('/memories').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)

    // The token is sent as a Bearer header — the ONLY use of the token.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${cfg.PM_USER_TOKEN}`)

    // The mapped error text never contains the secret token value.
    expect((err as ApiError).toAgentText()).not.toContain(cfg.PM_USER_TOKEN)
  })

  it('maps a 422 Shape-gate body through the client to a rejectPayload-bearing ApiError', async () => {
    stubFetch(422, REJECT_PAYLOAD)
    const client = new ApiClient(cfg)

    const err = (await client.post('/memories', { content: 'x' }).catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(422)
    expect(err.code).toBe('validation_failed')
    expect(err.rejectPayload()?.reason).toBe(REJECT_PAYLOAD.reason)
  })

  it('maps a 403 not_owner body through the client', async () => {
    stubFetch(403, { error: 'not_owner' })
    const client = new ApiClient(cfg)

    const err = (await client.post('/memories', {}).catch((e) => e)) as ApiError
    expect(err.status).toBe(403)
    expect(err.code).toBe('not_owner')
    expect(err.toAgentText()).toMatch(/memories you created/i)
  })

  it('a 2xx body is returned (no throw)', async () => {
    stubFetch(200, { ok: true, items: [] })
    const client = new ApiClient(cfg)
    const out = await client.get<{ ok: boolean }>('/health')
    expect(out.ok).toBe(true)
  })

  it('adds MCP request context to structured API logs without logging secrets', async () => {
    stubFetch(200, { ok: true })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const client = new ApiClient(cfg)

    await withMcpRequestContext({
      mcpSessionId: 'stream-abc',
      mcpTransportSessionId: 'abc',
      mcpClientName: 'codex-mcp-client 0.142.5',
      mcpRpcMethod: 'tools/call',
      mcpToolName: 'recall_context',
    }, () => client.post('/memories/search', { q: 'hello' }))

    const rendered = stderr.mock.calls.map((call) => String(call[0])).join('')
    expect(rendered).not.toContain(cfg.PM_USER_TOKEN)
    const row = JSON.parse(rendered.trim()) as Record<string, unknown>
    expect(row.msg).toBe('api')
    expect(row.mcpSessionId).toBe('stream-abc')
    expect(row.mcpRpcMethod).toBe('tools/call')
    expect(row.mcpToolName).toBe('recall_context')
    expect(row.path).toBe('/memories/search')
    expect(row.status).toBe(200)
  })
})
