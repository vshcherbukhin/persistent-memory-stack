/**
 * Unit matrix for client-managed embedding bridge gating.
 *
 * The contract (bridge.ts):
 *   • server-managed embeddings (mode='server') → NO local embed. bridgeEmbed returns
 *     {ok:true, vector:null}; the bridge embedder is never touched (it is null).
 *   • client-managed embeddings (mode='client-bridge') → local embed. bridgeEmbed calls the runtime
 *     bridge and returns the precomputed vector; addVectorFields attaches it as
 *     the API's AddBody {queryVector, embeddingModelId, embeddingDim} carrying
 *     the SERVER pin.
 *   • A local-embedding failure (EmbeddingError, e.g. model not pulled) becomes
 *     an actionable error string ending with `ollama pull <pinned-model>` — NOT
 *     a throw — so the tool can surface it as a ToolError.
 *
 * No Ollama, no network: the bridge embedder is a stub per-test.
 */
import { describe, it, expect, vi } from 'vitest'
import { EmbeddingError } from '@pm/shared'
import { bridgeEmbed, addVectorFields } from '../src/bridge.ts'
import type { Runtime } from '../src/runtime.ts'

const PIN = { modelId: 'qwen3-embedding:0.6b', dim: 1024 }

/** A server-managed runtime: server embeds, no local bridge. */
function serverRuntime(): Runtime {
  return { mode: 'server', deploymentMode: 'server', pin: PIN, bridge: null }
}

/** A client-managed runtime whose bridge embedder is a controllable stub. */
function bridgeRuntime(
  embed: Runtime['bridge'] extends infer B ? NonNullable<B>['embed'] : never,
  reportEmbeddingHealth?: Runtime['reportEmbeddingHealth'],
): Runtime {
  return { mode: 'client-bridge', deploymentMode: 'server', pin: PIN, bridge: { embed }, reportEmbeddingHealth }
}

describe('bridgeEmbed — server-managed gating: NO local embed', () => {
  it('returns {ok:true, vector:null} and never calls a bridge', async () => {
    const rt = serverRuntime()
    const res = await bridgeEmbed(rt, 'some query text', 'query')
    expect(res).toEqual({ ok: true, vector: null })
  })

  it('treats a client-bridge mode with a null bridge as server (defensive)', async () => {
    const rt: Runtime = { mode: 'client-bridge', deploymentMode: 'server', pin: PIN, bridge: null }
    const res = await bridgeEmbed(rt, 'text', 'document')
    expect(res).toEqual({ ok: true, vector: null })
  })
})

describe('bridgeEmbed — client-managed gating: local embed attached', () => {
  it('calls the bridge with [text]+kind and returns the precomputed vector', async () => {
    const vector = Array.from({ length: PIN.dim }, (_, i) => i / PIN.dim)
    const embed = vi.fn(async (_texts: string[], _kind: string) => [vector])
    const rt = bridgeRuntime(embed)

    const res = await bridgeEmbed(rt, 'a memory to store', 'document')
    expect(res).toEqual({ ok: true, vector })
    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed).toHaveBeenCalledWith(['a memory to store'], 'document')
  })

  it('reports a successful client-managed request without exposing a global observer scope', async () => {
    const reportEmbeddingHealth = vi.fn(async () => undefined)
    const rt = bridgeRuntime(async () => [[0.1, 0.2]], reportEmbeddingHealth)

    await expect(bridgeEmbed(rt, 'a memory to store', 'document')).resolves.toMatchObject({ ok: true })

    expect(reportEmbeddingHealth).toHaveBeenCalledWith({ ok: true })
  })

  it('passes the SEARCH kind through to the bridge', async () => {
    const embed = vi.fn(async () => [[0.1, 0.2, 0.3]])
    const rt = bridgeRuntime(embed)
    await bridgeEmbed(rt, 'find this', 'query')
    expect(embed).toHaveBeenCalledWith(['find this'], 'query')
  })

  it('normalizes a missing vector (embedder returned []) to null', async () => {
    const embed = vi.fn(async () => [])
    const rt = bridgeRuntime(embed)
    const res = await bridgeEmbed(rt, 'x', 'document')
    expect(res).toEqual({ ok: true, vector: null })
  })

  it('an unavailable local model becomes a safe actionable error and reports only a canonical code', async () => {
    const embed = vi.fn(async () => {
      throw new EmbeddingError('model "qwen3-embedding:0.6b" is not pulled', {
        provider: 'ollama',
        model: PIN.modelId,
        kind: 'config',
      })
    })
    const rt = bridgeRuntime(embed)

    const res = await bridgeEmbed(rt, 'x', 'document')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.error).toMatch(/Local embedding failed \(client-managed embeddings \/ client-bridge\)/)
    expect(res.error).toContain('configured model is unavailable')
    expect(res.error).not.toContain('is not pulled')
    expect(res.error).toContain(`"${PIN.modelId}" @ ${PIN.dim}-dim`)
    expect(res.error).toContain(`ollama pull ${PIN.modelId}`)
  })

  it('reports an out-of-tokens bridge error as a canonical scoped observation', async () => {
    const reportEmbeddingHealth = vi.fn(async () => undefined)
    const rt = bridgeRuntime(async () => {
      throw new EmbeddingError('quota exhausted: secret billing detail', {
        provider: 'ollama', model: PIN.modelId, kind: 'http', status: 402,
      })
    }, reportEmbeddingHealth)

    const res = await bridgeEmbed(rt, 'x', 'document')

    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('out of tokens') })
    expect(res).not.toMatchObject({ error: expect.stringContaining('secret billing detail') })
    expect(reportEmbeddingHealth).toHaveBeenCalledWith({ ok: false, code: 'embedding_quota_exhausted' })
  })

  it('a non-EmbeddingError throw stays a safe unavailable result (still no throw)', async () => {
    const embed = vi.fn(async () => {
      throw new TypeError('boom')
    })
    const rt = bridgeRuntime(embed)
    const res = await bridgeEmbed(rt, 'x', 'document')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.error).toContain('Local embeddings are unavailable')
    expect(res.error).not.toContain('boom')
  })
})

describe('addVectorFields — client-managed ADD body carries the precomputed vector + server pin', () => {
  it('builds {queryVector, embeddingModelId, embeddingDim} from the runtime pin', () => {
    const rt = serverRuntime() // pin is what matters here, not mode
    const vector = [0.1, 0.2, 0.3]
    const fields = addVectorFields(rt, vector)
    expect(fields).toEqual({
      queryVector: vector,
      embeddingModelId: PIN.modelId,
      embeddingDim: PIN.dim,
    })
  })
})
