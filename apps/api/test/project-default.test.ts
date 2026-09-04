/**
 * Contract test for the add_memory body's `project` field
 * (api/src/routes/memories.ts AddBody): project is REQUIRED, defaults to
 * "general" when omitted, rejects empty string (min(1)), and preserves any
 * explicit value. The "every memory must name its project" guarantee is
 * enforced at the request-shape (Zod 400) layer, NOT papered over by the DB
 * default — so the default lives in the schema.
 *
 * The AddBody schema is local to memoryRoutes() and not exported, so we (a)
 * exercise the EXACT schema construct against the same Zod the route uses, and
 * (b) assert the route source still declares it that way (drift guard) so a
 * change to the route's default/min is caught here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// The verbatim construct the route uses for the add_memory body's `project`.
const Project = z.string().min(1).default('general')

describe('add_memory project field — required, defaults to "general"', () => {
  it('omitted → defaults to "general"', () => {
    expect(Project.parse(undefined)).toBe('general')
  })

  it('explicit value is preserved (not overridden by the default)', () => {
    expect(Project.parse('media-planner')).toBe('media-planner')
    expect(Project.parse('general')).toBe('general')
  })

  it('empty string is rejected (min(1)) — never silently coerced to "general"', () => {
    const r = Project.safeParse('')
    expect(r.success).toBe(false)
  })

  it('inside an object body, an absent project key fills in "general"', () => {
    const Body = z.object({ content: z.string(), project: Project }).strict()
    expect(Body.parse({ content: 'x' })).toMatchObject({ project: 'general' })
    expect(Body.parse({ content: 'x', project: 'p' })).toMatchObject({ project: 'p' })
  })

  it('non-string project is rejected', () => {
    // safeParse takes `unknown`, so a number is a runtime (not type) failure.
    expect(Project.safeParse(123 as unknown).success).toBe(false)
  })
})

describe('drift guard — the route still declares the default + min on the add body', () => {
  it('memories.ts contains z.string().min(1).default(\'general\') for the write body', () => {
    const routePath = fileURLToPath(
      new URL('../src/routes/memories.ts', import.meta.url),
    )
    const src = readFileSync(routePath, 'utf8')
    expect(src).toContain(".min(1).default('general')")
  })
})
