import { describe, expect, it, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'

const h = vi.hoisted(() => ({
  deploymentMode: 'server',
  lastIssue: undefined as { userId: string; expiresAt: Date | null } | undefined,
}))

vi.mock('../src/config.ts', () => ({
  config: {
    get DEPLOYMENT_MODE() {
      return h.deploymentMode
    },
  },
}))

vi.mock('../src/auth/token-service.ts', () => ({
  issueToken: vi.fn(async (userId: string, expiresAt: Date | null) => {
    h.lastIssue = { userId, expiresAt }
    return { tokenId: 'tok123', wireToken: 'tok123.secret', expiresAt }
  }),
}))

import { connectRoutes } from '../src/routes/connect.ts'

async function appWithIdentity() {
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.addHook('onRequest', (req, _reply, done) => {
    req.identity = {
      userId: '11111111-1111-4111-8111-111111111111',
      teamId: '22222222-2222-4222-8222-222222222222',
      adminLevel: 'none',
      isTeamMember: true,
      isTeamAdmin: false,
      isGlobalSuperuser: false,
      mountedTeamIds: [],
      insideTenantTx: false,
    }
    done()
  })
  await app.register(connectRoutes)
  return app
}

beforeEach(() => {
  h.deploymentMode = 'server'
  h.lastIssue = undefined
})

describe('connect local dashboard token route', () => {
  it('mints a connector token for the authenticated non-admin user', async () => {
    const app = await appWithIdentity()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/connect/local-dashboard/token',
        payload: { expiresAt: '2030-01-01T00:00:00.000Z' },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({
        tokenId: 'tok123',
        wireToken: 'tok123.secret',
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          teamId: '22222222-2222-4222-8222-222222222222',
          adminLevel: 'none',
        },
      })
      expect(h.lastIssue?.userId).toBe('11111111-1111-4111-8111-111111111111')
    } finally {
      await app.close()
    }
  })

  it('is disabled for local personal stacks', async () => {
    h.deploymentMode = 'local'
    const app = await appWithIdentity()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/connect/local-dashboard/token',
        payload: {},
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('local_mode_not_supported')
      expect(h.lastIssue).toBeUndefined()
    } finally {
      await app.close()
    }
  })
})
