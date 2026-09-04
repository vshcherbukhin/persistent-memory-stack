import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  connectorEmailMatchesLocalProfile,
  decideSharedConnectionCompatibility,
} from '../src/services/shared-connection.ts'

describe('shared memory connection compatibility', () => {
  it('accepts server-managed shared servers without requiring a local embedding match', () => {
    expect(decideSharedConnectionCompatibility({
      local: { model: 'qwen3-embedding:4b', dim: 2560 },
      remote: { topology: 'server-managed-embeddings', model: 'voyage-3-large', dim: 1024 },
    })).toEqual({ ok: true, requiresLocalEmbedding: false })
  })

  it('requires a compatible local embedding model for client-managed shared servers', () => {
    expect(decideSharedConnectionCompatibility({
      local: { model: 'qwen3-embedding:4b', dim: 2560 },
      remote: { topology: 'client-managed-embeddings', model: 'qwen3-embedding:4b', dim: 2560 },
    })).toEqual({ ok: true, requiresLocalEmbedding: true })
  })

  it('blocks incompatible client-managed shared pins with an actionable reason', () => {
    const result = decideSharedConnectionCompatibility({
      local: { model: 'qwen3-embedding:4b', dim: 2560 },
      remote: { topology: 'client-managed-embeddings', model: 'qwen3-embedding:8b', dim: 4096 },
    })

    expect(result.ok).toBe(false)
    expect(result.requiresLocalEmbedding).toBe(true)
    expect(result.reason).toMatch(/qwen3-embedding:8b @ 4096/)
  })

  it('keeps shared connection management local-dashboard-only', () => {
    const route = readFileSync(new URL('../src/routes/dashboard/shared-connection.ts', import.meta.url), 'utf8')

    expect(route).toContain('function assertLocalConnectionSurface')
    expect(route).toContain("config.DEPLOYMENT_MODE !== 'local'")
    expect(route).toContain('Shared Memories connections are managed from the local personal dashboard.')
  })

  it('matches connector tokens to the local profile email before saving', () => {
    expect(connectorEmailMatchesLocalProfile('Vlad@example.test', 'vlad@example.test')).toBe(true)
    expect(connectorEmailMatchesLocalProfile(' vlad@example.test ', 'VLAD@example.test')).toBe(true)
    expect(connectorEmailMatchesLocalProfile('vlad@example.test', 'other@example.test')).toBe(false)
    expect(connectorEmailMatchesLocalProfile(null, 'vlad@example.test')).toBe(false)
    expect(connectorEmailMatchesLocalProfile('vlad@example.test', null)).toBe(false)
  })

  it('persists the connector email guard in the dashboard route', () => {
    const route = readFileSync(new URL('../src/routes/dashboard/shared-connection.ts', import.meta.url), 'utf8')

    expect(route).toContain('assertConnectorEmailMatchesLocalProfile')
    expect(route).toContain('connectorEmailMatchesLocalProfile')
    expect(route).toContain('shared_connection_email_mismatch')
    expect(route).toContain('tested.whoami.userEmail')
  })
})
