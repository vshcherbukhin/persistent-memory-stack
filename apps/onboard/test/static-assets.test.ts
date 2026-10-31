import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { describe, expect, it } from 'vitest'

describe('installer static assets with patched filesystem matching', () => {
  it.each([true, false])('serves nested assets and keeps files outside the root private (wildcard=%s)', async wildcard => {
    const parent = await realpath(tmpdir())
    const fixture = await mkdtemp(join(parent, 'pm-static-'))
    const root = join(fixture, 'public')
    const app = Fastify()
    try {
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(join(root, 'index.html'), '<h1>Installer</h1>')
      await writeFile(join(root, 'assets', 'app.js'), 'window.installer = true')
      await writeFile(join(fixture, 'private.txt'), 'must stay outside the public root')
      await app.register(fastifyStatic, { root, wildcard })
      expect((await app.inject('/index.html')).body).toBe('<h1>Installer</h1>')
      expect((await app.inject('/assets/app.js')).body).toBe('window.installer = true')
      const traversal = await app.inject('/%2e%2e/private.txt')
      expect(traversal.statusCode).toBeGreaterThanOrEqual(400)
      expect(traversal.body).not.toContain('must stay outside the public root')
    } finally {
      await app.close()
      expect(dirname(fixture)).toBe(parent)
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
