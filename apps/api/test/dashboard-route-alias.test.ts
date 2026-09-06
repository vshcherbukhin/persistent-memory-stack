import Fastify from 'fastify'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { dashboardRoutes } from '../src/routes/dashboard/index.ts'

const queues = vi.hoisted(() => ({
  scheduled: vi.fn(() => Object.freeze({})),
  memoryGraphRebuild: vi.fn(() => Object.freeze({})),
}))

// Route imports construct producer queues outside Fastify's lifecycle. This
// registration-only test keeps the real routes/schemas but must not open Redis
// connections that can emit errors after app.close() and Vitest teardown.
vi.mock('@pm/shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('@pm/shared')>(),
  makeScheduledQueue: queues.scheduled,
  makeMemoryGraphRebuildQueue: queues.memoryGraphRebuild,
}))

const routesDir = new URL('../src/routes/dashboard/', import.meta.url)

function declaredDashboardRoutes(): Array<{ method: string; path: string; file: string }> {
  const routes: Array<{ method: string; path: string; file: string }> = []
  const routePattern = /z4\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g

  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.ts') || file === 'index.ts' || file === 'shared.ts') continue
    const source = readFileSync(new URL(file, routesDir), 'utf8')
    for (const match of source.matchAll(routePattern)) {
      routes.push({
        method: match[1]!.toUpperCase(),
        path: match[2]!,
        file,
      })
    }
  }

  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`))
}

describe('dashboard route aliases', () => {
  it('registers every canonical /dashboard route with a one-release /admin compatibility alias', async () => {
    const app = Fastify()
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    try {
      await app.register(dashboardRoutes)
      await app.ready()

      expect(queues.scheduled).toHaveBeenCalledOnce()
      expect(queues.memoryGraphRebuild).toHaveBeenCalledOnce()
      const expected = declaredDashboardRoutes()
      expect(expected.length).toBeGreaterThan(50)

      for (const route of expected) {
        for (const prefix of ['/dashboard', '/admin'] as const) {
          const url = `${prefix}${route.path}`
          expect(app.hasRoute({ method: route.method, url }), `${route.file}: ${route.method} ${url}`).toBe(true)
        }
      }
    } finally {
      await app.close()
    }
  })
})
