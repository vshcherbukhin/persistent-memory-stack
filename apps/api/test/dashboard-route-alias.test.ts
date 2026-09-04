import Fastify from 'fastify'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { dashboardRoutes } from '../src/routes/dashboard/index.ts'

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
    await app.register(dashboardRoutes)
    await app.ready()

    try {
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
