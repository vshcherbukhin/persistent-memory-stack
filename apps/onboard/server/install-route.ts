import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { validateEnvForDeploy } from './env.js'
import { runInstall, type InstallEvent, type WizardPayload } from './install.js'
import { createNdjsonStream } from './ndjson.js'
import { resourceGate } from './resource-gate.js'
import type { ResourceSnapshot } from '../shared/resource-policy.js'
import { environmentIssues, type EnvironmentSnapshot } from '../shared/environment.js'

export interface InstallRouteOptions<Body extends { resourceAcknowledged?: boolean }> {
  root: string
  envPath: string
  /** Synchronously reserve installation activity, or return null if busy. */
  beginInstallation: () => (() => void) | null
  readResources: () => Promise<ResourceSnapshot>
  checkEnvironment: (env: Record<string, string>) => Promise<EnvironmentSnapshot>
  buildWizard: (body: Body) => WizardPayload
  onToken?: (token: string) => void
  run?: typeof runInstall
}

/** The same activity reservation protects validation, configuration capture and
 * all streamed work. No async gap may precede reservation of the saved env. */
export function registerInstallRoute<Body extends { resourceAcknowledged?: boolean }>(app: FastifyInstance, options: InstallRouteOptions<Body>): void {
  app.post<{ Body: Body }>('/api/install', async (req, reply) => {
    const release = options.beginInstallation()
    if (!release) return reply.code(409).send({ error: 'installation_active', message: 'An installation or embedding test is already running. Wait for it to finish before retrying.' })
    try {
      const body = (req.body ?? {}) as Body
      if (!existsSync(options.envPath)) return reply.code(400).send({ error: 'no_env', message: 'Generate the .env first (POST /api/env).' })
      const envText = readFileSync(options.envPath, 'utf8')
      const env = parseEnv(envText) as Record<string, string>
      const issues = validateEnvForDeploy(env)
      if (issues.length) return reply.code(400).send({
        error: 'invalid_env', message: `Missing required env value(s): ${issues.map(issue => issue.key).join(', ')}`, issues,
      })
      const snapshot = await options.readResources()
      const blocked = resourceGate(snapshot, { provider: env.EMBED_PROVIDER ?? '', model: env.EMBED_MODEL ?? '' }, body.resourceAcknowledged === true)
      if (blocked) return reply.code(422).send({ error: 'resource_requirements', message: blocked })
      const environment = await options.checkEnvironment(env)
      const requirements = environmentIssues(environment)
      if (requirements.length) return reply.code(422).send({ error: 'environment_requirements', message: requirements.map((issue) => issue.message).join(' '), issues: requirements })
      if (!existsSync(options.envPath) || readFileSync(options.envPath, 'utf8') !== envText) {
        return reply.code(409).send({ error: 'configuration_changed', message: 'The saved configuration changed during environment checks. Review it and start installation again.' })
      }
      const wizard = options.buildWizard(body)
      const stream = createNdjsonStream(reply)
      const emit = (event: InstallEvent): void => {
        if (event.type === 'token' && event.token) options.onToken?.(event.token)
        stream.emit(event)
      }
      try {
        await (options.run ?? runInstall)({ root: options.root, env, wizard, expectedEnvText: envText }, emit)
      } catch (error) {
        stream.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        stream.emit({ type: 'done', ok: false })
      } finally { stream.end() }
    } finally { release() }
  })
}
